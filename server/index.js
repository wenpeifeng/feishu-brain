require('./env');

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleRequest } = require('./router');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    await handleRequest(req, res);
    return;
  }

  let filePath = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
        });
        return;
      }
      res.writeHead(500);
      res.end('Server error');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      // 禁用缓存，避免改了 css/js 浏览器仍用旧文件
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${PORT} 已被占用，服务无法启动。`);
    console.error(`   可能是已有一个实例在跑。解决办法二选一：`);
    console.error(`   1) 关掉占用它的进程：  lsof -ti:${PORT} | xargs kill -9`);
    console.error(`   2) 换个端口启动：      PORT=3001 npm start\n`);
    process.exit(1);
  }
  console.error('服务启动失败：', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Feishu KB QA server running at http://${HOST}:${PORT}`);
});
