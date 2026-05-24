// Tiny dev server: serves /www on a port (default 5180)
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', 'www');
const port = Number(process.env.PORT || 5180);
const mime = { '.html':'text/html;charset=utf8', '.js':'application/javascript;charset=utf8',
  '.json':'application/json;charset=utf8', '.css':'text/css;charset=utf8', '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.ico':'image/x-icon', '.docx':'application/octet-stream' };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const p = path.join(root, u === '/' ? '/index.html' : u);
  if (!p.startsWith(root)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found: ' + u); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(p).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, () => console.log('dev server: http://localhost:' + port));
