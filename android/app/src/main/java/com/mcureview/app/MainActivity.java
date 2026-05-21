package com.mcureview.app;

/*
 * Copyright (c) 2025 微机原理复习宝典
 * All rights reserved.
 */

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerPlugin(ApkInstallerPlugin.class);
    }
}
