'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, file), 'utf8');
const rows = vm.runInNewContext(read('数据/牌桌数据.js') + '\ncardRows');
const files = ['index.html', 'styles.css', 'app.js', 'rules.js', 'music.js', 'voice.js', 'online.js',
  '数据/牌桌数据.js', '录音/播报素材.js', '录音/胜利语音.js', '录音/胜利配图.jpg',
  '卡牌/00_牌背.webp', ...rows.map(card => `卡牌/${card.id}_${card.name}.webp`)];
const assets = Object.fromEntries(files.map(file => {
  const content = file === 'index.html'
    ? Buffer.from(read(file).replace('</head>', '  <meta name="friend-server" content="">\n</head>'))
    : fs.readFileSync(path.join(__dirname, file));
  return [file, content.toString('base64')];
}));
const rules = read('rules.js').split("if (typeof module !== 'undefined')")[0];
const lobby = read('multiplayer.cjs')
  .replace("const { randomBytes } = require('node:crypto');",
    "const randomBytes = length => ({ toString: () => Array.from(crypto.getRandomValues(new Uint8Array(length)), byte => byte.toString(16).padStart(2, '0')).join('') });")
  .replace("const Rules = require('./rules.js');", '')
  .replace(/^module\.exports = .*;$/m, '');
const output = path.join(__dirname, 'dist/server');
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, 'index.js'),
  `const ASSETS = ${JSON.stringify(assets)};\nconst cardRows = ${JSON.stringify(rows)};\n` +
  rules + '\n' + lobby + '\n' + read('site-worker.mjs'));
