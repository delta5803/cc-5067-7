#!/usr/bin/env node
// Zero-dependency static server for the stereo width mastering panel.
// Usage: node server.js [--port 8770] [--host 127.0.0.1]

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, 'web');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(arg('--port', process.env.PORT || 8770));
const HOST = arg('--host', process.env.HOST || '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = path.normalize(path.join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT + path.sep) && filePath !== path.join(WEB_ROOT, 'index.html')) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    let data;
    try {
      data = await readFile(filePath);
    } catch {
      // SPA-ish fallback to index for unknown non-asset paths.
      if (!path.extname(pathname)) {
        data = await readFile(path.join(WEB_ROOT, 'index.html'));
      } else {
        res.writeHead(404); res.end('Not found'); return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500); res.end('Server error: ' + err.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  立体声宽度母带试听面板');
  console.log('  Stereo Width Mastering Panel');
  console.log('');
  console.log(`  open:  http://${HOST}:${PORT}/`);
  console.log('  tests: npm test  (node test/run.mjs)');
  console.log('');
});
