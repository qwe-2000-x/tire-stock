/**
 * 轮胎库存管理 · 云端接口（Cloudflare Worker + D1）
 *
 * 公开接口（谁都能用，不用登录）：
 *   GET  /api/catalog          商品价格 + 当前库存（一次取全，前端本地过滤）
 *   POST /api/login            管理口令换登录令牌
 *
 * 管理员接口（要带 Authorization: Bearer <token>）：
 *   POST   /api/stock/in            单条入库
 *   POST   /api/stock/out           单条出库
 *   POST   /api/stock/import        批量出入库（一次最多 200 行，前端自己分批）
 *   POST   /api/products/import     导入价格表（整份替换同一份价格表的数据）
 *   GET    /api/movements           最近出入库流水
 *   GET    /api/admins              管理员名单（仅超级管理员）
 *   POST   /api/admins              新增管理员（仅超级管理员）
 *   DELETE /api/admins/:id          删除管理员（仅超级管理员）
 *
 * 权限校验全部在云端完成，前端改代码也绕不过去。
 */

const MAX_IMPORT_ROWS = 200;      // 单次批量出入库上限
const MAX_PRICE_ROWS = 8000;      // 单次价格表导入上限
const INSERT_CHUNK = 40;          // 写库分批大小
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 登录有效期 30 天

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    try {
      if (path === '/api' || path.startsWith('/api/')) {
        return await handleApi(request, env, path, url);
      }
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return errJson('服务器出错：' + (err && err.message ? err.message : String(err)), 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function normalizePath(p) {
  const s = String(p || '/').replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function okJson(data = {}) {
  return json({ ok: true, ...data });
}

function errJson(error, status = 400) {
  return json({ ok: false, error }, status);
}

function sessionSecret(env) {
  return env.SESSION_SECRET || env.SUPER_PASSWORD || 'tire-stock-dev-secret';
}

async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(data)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hashPassword(env, password) {
  return hmacHex(sessionSecret(env) + '|password', password);
}

function b64urlEncode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const pad = text.length % 4 ? '='.repeat(4 - (text.length % 4)) : '';
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* 字段处理：只有真正填了值的字段才写库                                  */
/* ------------------------------------------------------------------ */

function pickText(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\uFEFF/g, '').trim();
  return s === '' ? null : s;
}

function pickInt(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\s,，]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  return n;
}

function pickNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\s,，¥￥元]/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 库存主键：规格 + 花纹（花纹统一成字符串，空的就是空串） */
function itemKey(model, pattern) {
  return String(model || '') + '\u0001' + String(pattern || '');
}

/* ------------------------------------------------------------------ */
/* 一次入库或出库                                                       */
/* ------------------------------------------------------------------ */

/**
 * @returns {{ok: true, action: string, quantity: number} | {ok: false, error: string}}
 */
async function applyOperation(env, op, operator) {
  const action = op.action === 'out' ? 'out' : op.action === 'in' ? 'in' : null;
  if (!action) return { ok: false, error: '操作只能填 入库 或 出库' };

  const model = pickText(op.model);
  const pattern = pickText(op.pattern) || '';
  const qty = pickInt(op.quantity);
  const unitPrice = pickNumber(op.unitPrice);

  if (!model || qty === null || qty <= 0) {
    return { ok: false, error: '请填写完整的入库/出库信息' };
  }

  const now = new Date().toISOString();
  const row = await env.DB
    .prepare('SELECT * FROM stock WHERE model = ? AND pattern = ? AND warehouse = ?')
    .bind(model, pattern, '')
    .first();

  if (action === 'in') {
    if (!row) {
      await env.DB
        .prepare(
          'INSERT INTO stock (model, pattern, warehouse, quantity, updatedAt) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(model, pattern, '', qty, now)
        .run();
    } else {
      // 已存在就把数量加上去，不是覆盖
      await env.DB
        .prepare('UPDATE stock SET quantity = ?, updatedAt = ? WHERE id = ?')
        .bind(row.quantity + qty, now, row.id)
        .run();
    }
  } else {
    if (!row) return { ok: false, error: '该规格当前没有库存' };
    if (qty > row.quantity) return { ok: false, error: `库存不足（当前 ${row.quantity} 条）` };

    const left = row.quantity - qty;
    if (left === 0) {
      await env.DB.prepare('DELETE FROM stock WHERE id = ?').bind(row.id).run();
    } else {
      await env.DB.prepare('UPDATE stock SET quantity = ?, updatedAt = ? WHERE id = ?').bind(left, now, row.id).run();
    }
  }

  // 每一笔都记流水，单价存下来
  await env.DB
    .prepare(
      'INSERT INTO movements (model, pattern, quantity, unitPrice, action, operator, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(model, pattern, qty, unitPrice, action, operator || '', now)
    .run();

  return { ok: true, action, quantity: qty };
}

/* ------------------------------------------------------------------ */
/* 商品 + 库存 合并列表                                                 */
/* ------------------------------------------------------------------ */

async function buildCatalog(env) {
  const products =
    (await env.DB.prepare('SELECT * FROM products ORDER BY model ASC, pattern ASC').all()).results || [];
  const stocks = (await env.DB.prepare('SELECT * FROM stock').all()).results || [];

  const stockMap = new Map();
  for (const s of stocks) {
    const key = itemKey(s.model, s.pattern);
    stockMap.set(key, (stockMap.get(key) || 0) + s.quantity);
  }

  const used = new Set();
  const items = [];

  for (const p of products) {
    const key = itemKey(p.model, p.pattern);
    used.add(key);
    items.push({
      key,
      model: p.model,
      pattern: p.pattern || '',
      series: p.series || '',
      storePrice: p.storePrice ?? null,
      netPrice: p.netPrice ?? null,
      priceList: p.priceList || '',
      quantity: stockMap.get(key) || 0,
    });
  }

  // 有库存但价格表里没有的规格，也要能查到
  for (const s of stocks) {
    const key = itemKey(s.model, s.pattern);
    if (used.has(key)) continue;
    used.add(key);
    items.push({
      key,
      model: s.model,
      pattern: s.pattern || '',
      series: '',
      storePrice: null,
      netPrice: null,
      priceList: '',
      quantity: s.quantity,
    });
  }

  items.sort((a, b) => {
    const m = String(a.model).localeCompare(String(b.model));
    return m !== 0 ? m : String(a.pattern).localeCompare(String(b.pattern));
  });
  return items;
}

/* ------------------------------------------------------------------ */
/* 登录与鉴权                                                          */
/* ------------------------------------------------------------------ */

async function signToken(env, payload) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(sessionSecret(env), body);
  return `${body}.${sig}`;
}

async function requireAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  if (!token) return { ok: false, error: '请先登录管理员' };

  const dot = token.indexOf('.');
  if (dot <= 0) return { ok: false, error: '登录已失效，请重新登录' };

  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, await hmacHex(sessionSecret(env), body))) {
    return { ok: false, error: '登录已失效，请重新登录' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch (e) {
    return { ok: false, error: '登录已失效，请重新登录' };
  }
  if (!payload || !payload.exp || payload.exp < Date.now()) {
    return { ok: false, error: '登录已过期，请重新登录' };
  }

  // 普通管理员每次操作都回数据库核对，被删掉就立刻失效
  if (payload.role !== 'super') {
    const still = await env.DB.prepare('SELECT id FROM admins WHERE id = ?').bind(payload.id).first();
    if (!still) return { ok: false, error: '无管理员权限，请重新登录' };
  }
  return { ok: true, admin: payload };
}

async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errJson('请求格式不对');
  }
  const password = String((body && body.password) || '').trim();
  if (!password) return errJson('请输入管理口令');

  const superPassword = String(env.SUPER_PASSWORD || '');
  if (superPassword && safeEqual(password, superPassword)) {
    const token = await signToken(env, {
      id: 0,
      name: '超级管理员',
      role: 'super',
      exp: Date.now() + SESSION_TTL_MS,
    });
    return okJson({ token, name: '超级管理员', role: 'super' });
  }

  const passHash = await hashPassword(env, password);
  const admins = await env.DB.prepare('SELECT * FROM admins').all();
  const hit = (admins.results || []).find((a) => safeEqual(a.passHash, passHash));
  if (!hit) return errJson('口令不对，或你不是管理员', 401);

  const token = await signToken(env, {
    id: hit.id,
    name: hit.name,
    role: 'admin',
    exp: Date.now() + SESSION_TTL_MS,
  });
  return okJson({ token, name: hit.name, role: 'admin' });
}

/* ------------------------------------------------------------------ */
/* 写库小工具                                                          */
/* ------------------------------------------------------------------ */

async function runInsertChunks(env, statements) {
  for (let i = 0; i < statements.length; i += INSERT_CHUNK) {
    const chunk = statements.slice(i, i + INSERT_CHUNK);
    if (typeof env.DB.batch === 'function') {
      await env.DB.batch(chunk);
    } else {
      for (const stmt of chunk) await stmt.run();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

async function handleApi(request, env, path, url) {
  const method = request.method.toUpperCase();

  /* ---------- 公开接口 ---------- */

  if (path === '/api/catalog' && method === 'GET') {
    return okJson({ items: await buildCatalog(env) });
  }

  if (path === '/api/login' && method === 'POST') {
    return await handleLogin(request, env);
  }

  /* ---------- 以下都要管理员 ---------- */

  const auth = await requireAdmin(request, env);
  if (!auth.ok) return errJson(auth.error, 401);
  const operator = auth.admin.name || '';

  if ((path === '/api/stock/in' || path === '/api/stock/out') && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errJson('请求格式不对');
    }
    const action = path.endsWith('/in') ? 'in' : 'out';
    const result = await applyOperation(env, { ...body, action }, operator);
    return result.ok ? okJson({ message: action === 'in' ? '入库成功' : '出库成功' }) : errJson(result.error);
  }

  // 批量出入库：一次最多 200 行，前端自己按 50 行一批提交
  if (path === '/api/stock/import' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errJson('请求格式不对');
    }
    const action = body && body.action === 'out' ? 'out' : 'in';
    const rows = body && Array.isArray(body.rows) ? body.rows : null;
    if (!rows) return errJson('没有要处理的数据');
    if (rows.length > MAX_IMPORT_ROWS) {
      return errJson(`一次最多处理 ${MAX_IMPORT_ROWS} 行，请分批提交`);
    }

    let success = 0;
    const firstErrors = [];
    for (let i = 0; i < rows.length; i += 1) {
      const result = await applyOperation(env, { ...rows[i], action }, operator);
      if (result.ok) {
        success += 1;
      } else if (firstErrors.length < 100) {
        firstErrors.push({ index: i, reason: result.error });
      }
    }
    return okJson({ success, fail: firstErrors.length, errors: firstErrors });
  }

  // 导入价格表：整份替换同一份价格表的数据，其他价格表不动
  if (path === '/api/products/import' && method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return errJson('请求格式不对');
    }
    const priceList = pickText(body && body.priceList) || '未命名价格表';
    const rows = body && Array.isArray(body.rows) ? body.rows : null;
    if (!rows || !rows.length) return errJson('没有解析到任何价格数据');
    if (rows.length > MAX_PRICE_ROWS) return errJson(`一次最多导入 ${MAX_PRICE_ROWS} 行`);

    const clean = [];
    for (const r of rows) {
      const model = pickText(r && r.model);
      if (!model) continue;
      clean.push({
        model,
        pattern: pickText(r.pattern),
        series: pickText(r.series),
        storePrice: pickNumber(r.storePrice),
        netPrice: pickNumber(r.netPrice),
      });
    }
    if (!clean.length) return errJson('没有解析到有效的「规格」数据');

    const now = new Date().toISOString();
    await env.DB.prepare('DELETE FROM products WHERE priceList = ?').bind(priceList).run();
    await runInsertChunks(
      env,
      clean.map((r) =>
        env.DB
          .prepare(
            'INSERT INTO products (model, pattern, series, storePrice, netPrice, priceList, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(r.model, r.pattern, r.series, r.storePrice, r.netPrice, priceList, now),
      ),
    );

    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM products').first();
    return okJson({
      priceList,
      imported: clean.length,
      skipped: rows.length - clean.length,
      total: total ? total.n : null,
    });
  }

  if (path === '/api/movements' && method === 'GET') {
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 200);
    const rows = await env.DB.prepare('SELECT * FROM movements ORDER BY id DESC LIMIT ?').bind(limit).all();
    return okJson({ items: rows.results || [] });
  }

  // 现有价格表清单，导入时用来提示"会替换哪一份"
  if (path === '/api/pricelists' && method === 'GET') {
    const rows = await env.DB
      .prepare('SELECT priceList AS name, COUNT(*) AS n FROM products GROUP BY priceList ORDER BY priceList ASC')
      .all();
    return okJson({
      items: (rows.results || []).map((r) => ({ name: r.name || '', count: r.n })),
    });
  }

  /* ---------- 管理员名单（只有超级管理员能改） ---------- */

  if (path === '/api/admins') {
    if (auth.admin.role !== 'super') return errJson('只有超级管理员能做权限移交', 403);

    if (method === 'GET') {
      const list = await env.DB.prepare('SELECT * FROM admins ORDER BY id ASC').all();
      return okJson({
        items: (list.results || []).map((a) => ({ id: a.id, name: a.name, createdAt: a.createdAt })),
      });
    }

    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch (e) {
        return errJson('请求格式不对');
      }
      const name = pickText(body && body.name);
      const password = String((body && body.password) || '').trim();
      if (!name) return errJson('请填写管理员名称');
      if (password.length < 6) return errJson('登录口令至少 6 位');

      const exists = await env.DB.prepare('SELECT * FROM admins WHERE name = ?').bind(name).first();
      if (exists) return errJson('已经有同名的管理员了');

      await env.DB
        .prepare('INSERT INTO admins (name, passHash, createdAt) VALUES (?, ?, ?)')
        .bind(name, await hashPassword(env, password), new Date().toISOString())
        .run();
      return okJson({ message: `已添加管理员：${name}` });
    }
  }

  if (path.startsWith('/api/admins/') && method === 'DELETE') {
    if (auth.admin.role !== 'super') return errJson('只有超级管理员能做权限移交', 403);
    const id = Number(path.slice('/api/admins/'.length));
    if (!Number.isInteger(id) || id <= 0) return errJson('参数不对');

    const target = await env.DB.prepare('SELECT id FROM admins WHERE id = ?').bind(id).first();
    if (!target) return errJson('这个管理员已经不存在了');
    await env.DB.prepare('DELETE FROM admins WHERE id = ?').bind(id).run();
    return okJson({ message: '已移除该管理员' });
  }

  return errJson('接口不存在', 404);
}
