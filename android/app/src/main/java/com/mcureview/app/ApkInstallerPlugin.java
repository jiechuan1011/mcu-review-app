package com.mcureview.app;

/*
 * Copyright (c) 2025 微机原理复习宝典
 * All rights reserved.
 */

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    /**
     * 从指定URL下载APK并调用系统安装器安装
     * 通过 downloadProgress 事件实时推送下载进度
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String url = call.getString("url", "");
        String fileName = call.getString("fileName", "update.apk");

        if (url.isEmpty()) {
            call.reject("URL is required");
            return;
        }

        executor.execute(() -> {
            try {
                HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.connect();

                int fileLength = conn.getContentLength();
                File cacheDir = getContext().getCacheDir();
                File apkFile = new File(cacheDir, fileName);

                InputStream is = conn.getInputStream();
                FileOutputStream fos = new FileOutputStream(apkFile);

                byte[] buffer = new byte[8192];
                int read;
                int total = 0;
                while ((read = is.read(buffer)) != -1) {
                    fos.write(buffer, 0, read);
                    total += read;
                    if (fileLength > 0) {
                        int progress = Math.min(99, (int) ((long) total * 100 / fileLength));
                        JSObject progressData = new JSObject();
                        progressData.put("progress", progress);
                        notifyListeners("downloadProgress", progressData);
                    }
                }
                fos.close();
                is.close();

                JSObject doneData = new JSObject();
                doneData.put("progress", 100);
                notifyListeners("downloadProgress", doneData);

                Uri apkUri = FileProvider.getUriForFile(getContext(),
                        getContext().getPackageName() + ".fileprovider", apkFile);

                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

                getActivity().startActivity(intent);

                JSObject result = new JSObject();
                result.put("success", true);
                result.put("message", "APK downloaded and install started");
                call.resolve(result);

            } catch (ActivityNotFoundException e) {
                call.reject("No package installer found on device");
            } catch (Exception e) {
                call.reject("Download failed: " + e.getMessage());
            }
        });
    }
}
