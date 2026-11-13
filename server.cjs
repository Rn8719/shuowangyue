'use strict';

const http = require('node:http');
const { readFileSync, createReadStream } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Rules = require('./rules.js');
const { Lobby } = require('./multiplayer.cjs');

const rows = vm.runInNewContext(readFileSync(path.join(__dirname, '数据/牌桌数据.js'), 'utf8') + '\ncardRows');
const staticFiles = new Set([
  'index.html', 'styles.css', 'app.js', 'rules.js', 'music.js', 'voice.js', 'online.js',
  '数据/牌桌数据.js', '录音/播报素材.js', '录音/胜利语音.js', '录音/胜利配图.jpg',
  '卡牌/00_牌背.webp', ...rows.map(card => `卡牌/${card.id}_${card.name}.webp`)
]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

function createServer() {
  const lobby = new Lobby(Rules.prepare(rows));
  const browserOrigin = process.env.PAGES_ORIGIN;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('OK');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      const origin = req.headers.origin;
      if (origin === browserOrigin && origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS' && origin && origin === browserOrigin) {
        res.writeHead(204).end();
        return;
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      try {
        if (req.method !== 'POST') throw Error('无效的请求方式');
        let text = '';
        req.setEncoding('utf8');
        for await (const chunk of req) {
          text += chunk;
          if (text.length > 4096) throw Error('请求过大');
        }
        const data = JSON.parse(text || '{}');
        const [operation, code] = url.pathname.slice(5).split('/');
        const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{48})$/)?.[1];
        const result = operation === 'create' ? lobby.create(data.name, data.count, data.rounds, data.code)
          : operation === 'join' ? lobby.join(code, data.name)
          : lobby.request(code, token, operation, data);
        if (result === null) {
          res.writeHead(403).end(JSON.stringify({ error: '房间已解散，或你已离开房间' }));
          return;
        }
        res.end(JSON.stringify(result));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    let file;
    try { file = decodeURIComponent(url.pathname.slice(1)) || 'index.html'; }
    catch { res.writeHead(400).end(); return; }
    if (!['GET', 'HEAD'].includes(req.method) || !staticFiles.has(file)) {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', mime[path.extname(file)]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    if (req.method === 'HEAD') { res.end(); return; }
    if (file === 'index.html') {
      res.end(readFileSync(path.join(__dirname, file), 'utf8')
        .replace('</head>', '  <meta name="friend-server" content="">\n</head>'));
      return;
    }
    const stream = createReadStream(path.join(__dirname, file));
    stream.on('error', () => { if (!res.headersSent) res.statusCode = 404; res.end(); });
    stream.pipe(res);
  });
  const timer = setInterval(() => lobby.tick(), 200);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? '127.0.0.1';
  createServer().listen(port, host, () => console.log(`朔望月好友房：http://${host}:${port}/`));
}

module.exports = { createServer };
