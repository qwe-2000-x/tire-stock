/**
 * 截图用的临时脚本：拿几款真实规格造点库存，截完再清掉。
 * 用法：node tools/demo-shots.mjs http://127.0.0.1:8787 口令
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const PASSWORD = process.argv[3] || 'dev-super-123456';
const PORT = 9377;
const OUT = path.resolve('shots');
fs.mkdirSync(OUT, { recursive: true });

async function api(path_, token, body) {
  const res = await fetch(BASE + path_, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(path_ + ' → ' + (data.error || res.status));
  return data;
}

const token = (await api('/api/login', null, { password: PASSWORD })).token;
const catalog = (await api('/api/catalog')).items;

/* 挑几款真实规格，造点库存 */
const picks = [
  { filter: (i) => i.model === '195/60R15', qty: 12 },
  { filter: (i) => i.model === '195/65R15', qty: 6 },
  { filter: (i) => i.model === '195/55R15', qty: 4 },
  { filter: (i) => i.model.startsWith('195/60R15 '), qty: 8 },
];

const seeded = [];
for (const pick of picks) {
  const item = catalog.find((i) => pick.filter(i));
  if (!item) continue;
  await api('/api/stock/in', token, {
    model: item.model,
    pattern: item.pattern,
    quantity: pick.qty,
    unitPrice: item.storePrice ? Math.round(item.storePrice * 0.72) : '',
  });
  seeded.push({ ...item, quantity: pick.qty });
}
console.log('造了 ' + seeded.length + ' 条库存：' + seeded.map((s) => s.model + '/' + s.pattern).join('、'));

const detail = seeded[0];

/* 开浏览器截图 */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tire-demo-'));
const chrome = spawn(
  fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    BASE + '/',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target = null;
for (let i = 0; i < 40 && !target; i += 1) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && t.url.startsWith(BASE));
  } catch (e) {}
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error('JS 出错：' + JSON.stringify(r.exceptionDetails.exception));
  return r.result.value;
};
const waitFor = async (expr, t = 12000) => {
  const end = Date.now() + t;
  while (Date.now() < end) {
    if (await js(expr)) return true;
    await sleep(150);
  }
  throw new Error('等不到：' + expr);
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  console.log('已保存 shots/' + name + '.png');
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 900, deviceScaleFactor: 2, mobile: true });
await waitFor(`document.querySelectorAll('.item').length > 0`);

await js(`(() => { const el = document.getElementById('searchInput'); el.value = '195'; el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
await sleep(500);
await shot('01-搜索195');

await js(
  `location.hash = '#/p/' + encodeURIComponent(${JSON.stringify(detail.model)}) + '/' + encodeURIComponent(${JSON.stringify(
    detail.pattern,
  )})`,
);
await waitFor(`location.hash.startsWith('#/p/')`);
await sleep(600);
await shot('02-商品详情');

await js(`location.hash = '#/admin'`);
await waitFor(`!document.getElementById('view-login').hidden`);
await js(
  `(() => { const el = document.getElementById('loginPassword'); el.value = ${JSON.stringify(
    PASSWORD,
  )}; el.dispatchEvent(new Event('input',{bubbles:true})); })()`,
);
await js(`document.getElementById('loginBtn').click()`);
await waitFor(`!document.getElementById('view-admin').hidden`);
await sleep(700);
await shot('03-管理后台');

await js(`window.scrollTo(0, document.body.scrollHeight * 0.45)`);
await sleep(400);
await shot('04-管理后台-导入区');

chrome.kill();
try {
  if (profile.startsWith(os.tmpdir())) fs.rmSync(profile, { recursive: true, force: true });
} catch (e) {}

/* 清掉演示库存 */
for (const item of seeded) {
  await api('/api/stock/out', token, { model: item.model, pattern: item.pattern, quantity: item.quantity });
}
const left = (await api('/api/catalog')).items.filter((i) => i.quantity > 0).length;
console.log('演示库存已清掉，现在有库存的规格数：' + left);
