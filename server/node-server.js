/**
 * 备选部署方式：把同一套代码跑在自己的服务器上（比如香港的轻量服务器）。
 *
 * 这个文件只做三件事：
 *   1. 把 Node 的 HTTP 请求翻译成 Worker 能认的 Request
 *   2. 用 Node 自带的 sqlite 冒充 Cloudflare D1
 *   3. 用本地 public 目录冒充静态资源绑定
 *
 * 业务逻辑一行都没有重复，全在 src/worker.js 里。
 *
 * 启动：node server/node-server.js
 * 端口：默认 3000，可用环境变量 PORT 改
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import worker from '../src/worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'tire-stock.db');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 用本地 sqlite 冒充 Cloudflare D1                                    */
/* ------------------------------------------------------------------ */

function createD1LikeDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');

  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...values) {
          args = values.map((v) => (v === undefined ? null : v));
          return stmt;
        },
        async first() {
          const row = db.prepare(sql).get(...args);
          return row === undefined ? null : row;
        },
        async all() {
          return { results: db.prepare(sql).all(...args) };
        },
        async run() {
          db.prepare(sql).run(...args);
          return { success: true };
        },
      };
      return stmt;
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 用本地文件冒充静态资源绑定                                          */
/* ------------------------------------------------------------------ */

const ASSETS = {
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/' || pathname === '') pathname = '/index.html';

    const full = path.join(PUBLIC_DIR, path.normalize(pathname));
    if (!full.startsWith(PUBLIC_DIR)) {
      return new Response('403 Forbidden', { status: 403 });
    }

    try {
      const data = await fsp.readFile(full);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
          'cache-control': full.endsWith('.html') ? 'no-store' : 'public, max-age=300',
        },
      });
    } catch (e) {
      return new Response('404 Not Found', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  },
};

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const DB = createD1LikeDatabase(DB_FILE);
DB.exec(fs.readFileSync(path.join(ROOT, 'schema.sql'), 'utf8'));

// 第一次启动时，如果价格表是空的，就把 seed.sql 灌进去
{
  const seedFile = path.join(ROOT, 'seed.sql');
  const row = await DB.prepare('SELECT COUNT(*) AS n FROM products').first();
  if (fs.existsSync(seedFile) && (!row || row.n === 0)) {
    DB.exec(fs.readFileSync(seedFile, 'utf8'));
    const after = await DB.prepare('SELECT COUNT(*) AS n FROM products').first();
    console.log(`已灌入价格表：${after ? after.n : 0} 条`);
  }
}

const env = {
  DB,
  ASSETS,
  SUPER_PASSWORD: process.env.SUPER_PASSWORD || '',
  SESSION_SECRET: process.env.SESSION_SECRET || '',
};

if (!env.SUPER_PASSWORD) {
  console.warn('⚠️  没有设置 SUPER_PASSWORD 环境变量，将没有任何人能登录管理后台。');
  console.warn('   设置方法（Windows PowerShell）：$env:SUPER_PASSWORD="你的口令"; node server/node-server.js');
  console.warn('   设置方法（Linux）：SUPER_PASSWORD=你的口令 node server/node-server.js');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
    }

    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = Buffer.concat(chunks);
    }

    const request = new Request(url, { method: req.method, headers, body });
    const response = await worker.fetch(request, env, {});
    const buffer = Buffer.from(await response.arrayBuffer());

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(buffer);
  } catch (err) {
    console.error('请求处理失败：', err);
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '服务器出错：' + err.message }));
  }
});

server.listen(PORT, () => {
  console.log(`轮胎库存管理已启动：http://127.0.0.1:${PORT}`);
  console.log(`数据库文件：${DB_FILE}`);
});
