/**
 * 轮胎库存管理 · 页面逻辑
 *
 * #/                   库存查询（谁都能看）
 * #/p/<规格>/<花纹>     商品详情
 * #/admin              管理员登录 / 管理后台
 */

import {
  buildPriceRows,
  buildStockRows,
  guessPriceListName,
  parseCsvText,
  readTableFile,
  toPricePayload,
  toStockPayload,
} from './table-file.js';

const BATCH_SIZE = 50;    // 每次提交给云端的行数
const PAGE_SIZE = 60;     // 列表一次渲染多少行

const state = {
  catalog: [],
  loaded: false,
  loadFailed: false,
  keyword: localStorage.getItem('tire_keyword') || '',
  token: localStorage.getItem('tire_token') || '',
  who: JSON.parse(localStorage.getItem('tire_who') || 'null'),
  view: 'list',
  current: null,
  limit: PAGE_SIZE,
  busy: false,
  parsed: { in: null, out: null, price: null },
  priceLists: [],
};

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && state.token) headers.authorization = 'Bearer ' + state.token;

  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    throw new Error('网络连接失败，请检查网络后重试');
  }

  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    data = null;
  }

  if (!res.ok) {
    if (res.status === 401 && auth) {
      clearSession();
      location.hash = '#/admin';
    }
    throw new Error((data && data.error) || `请求失败（${res.status}）`);
  }
  return data || {};
}

let toastTimer = null;
function toast(message, type = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = 'toast ' + type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, type === 'err' ? 3600 : 2000);
}

function overlay(show, text = '处理中…') {
  $('overlay').hidden = !show;
  $('overlayText').textContent = text;
  state.busy = show;
}

function saveSession() {
  if (state.token) localStorage.setItem('tire_token', state.token);
  else localStorage.removeItem('tire_token');
  if (state.who) localStorage.setItem('tire_who', JSON.stringify(state.who));
  else localStorage.removeItem('tire_who');
}

function clearSession() {
  state.token = '';
  state.who = null;
  saveSession();
}

function money(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '¥' + v;
  const text = Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '');
  return '¥' + text;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

/** 把命中的关键字标出来，不用 innerHTML，避免注入 */
function highlight(parent, text, keyword) {
  const value = String(text ?? '');
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) {
    parent.appendChild(document.createTextNode(value));
    return;
  }
  const lower = value.toLowerCase();
  let i = 0;
  for (;;) {
    const at = lower.indexOf(key, i);
    if (at < 0) {
      parent.appendChild(document.createTextNode(value.slice(i)));
      return;
    }
    if (at > i) parent.appendChild(document.createTextNode(value.slice(i, at)));
    const mark = document.createElement('mark');
    mark.textContent = value.slice(at, at + key.length);
    parent.appendChild(mark);
    i = at + key.length;
  }
}

/* ------------------------------------------------------------------ */
/* 弹窗                                                                */
/* ------------------------------------------------------------------ */

function showModal({ title, message, details = [], okText = '知道了', tone = '' }) {
  const mask = el('div', 'modal-mask');
  const box = el('div', 'modal');

  box.appendChild(el('h3', tone, title));
  if (message) box.appendChild(el('p', 'modal-message', message));

  if (details.length) {
    const list = el('ol', 'modal-list');
    for (const line of details) list.appendChild(el('li', null, line));
    box.appendChild(list);
  }

  const btn = el('button', 'btn primary', okText);
  btn.type = 'button';
  btn.onclick = () => mask.remove();
  box.appendChild(btn);

  mask.appendChild(box);
  mask.addEventListener('click', (ev) => {
    if (ev.target === mask) mask.remove();
  });
  document.body.appendChild(mask);
}

function confirmModal(message, { title = '请确认', okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    const mask = el('div', 'modal-mask');
    const box = el('div', 'modal');

    box.appendChild(el('h3', null, title));
    box.appendChild(el('p', 'modal-message', message));

    const row = el('div', 'modal-actions');
    const cancel = el('button', 'btn ghost', '取消');
    cancel.type = 'button';
    cancel.onclick = () => {
      mask.remove();
      resolve(false);
    };

    const done = el('button', 'btn ' + (danger ? 'danger' : 'primary'), okText);
    done.type = 'button';
    done.onclick = () => {
      mask.remove();
      resolve(true);
    };

    row.appendChild(cancel);
    row.appendChild(done);
    box.appendChild(row);
    mask.appendChild(box);
    mask.addEventListener('click', (ev) => {
      if (ev.target === mask) {
        mask.remove();
        resolve(false);
      }
    });
    document.body.appendChild(mask);
  });
}

/* ------------------------------------------------------------------ */
/* 页面切换                                                            */
/* ------------------------------------------------------------------ */

const VIEWS = ['list', 'detail', 'login', 'admin'];
const TITLES = { list: '轮胎库存', detail: '商品详情', login: '管理员登录', admin: '管理后台' };

function showView(name) {
  state.view = name;
  for (const key of VIEWS) $(`view-${key}`).hidden = key !== name;
  $('pageTitle').textContent = TITLES[name];
  $('backBtn').hidden = name === 'list';
  $('adminEntryBtn').hidden = name === 'login' || name === 'admin';
  window.scrollTo(0, 0);
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const parts = hash.split('/').map((p) => decodeURIComponent(p));

  if (parts[0] === 'p' && parts[1]) {
    state.current = { model: parts[1], pattern: parts[2] || '' };
    showView('detail');
    renderDetail();
    refreshCatalog(false);
    return;
  }

  if (parts[0] === 'admin') {
    if (!state.token) showView('login');
    else {
      showView('admin');
      renderAdmin();
    }
    return;
  }

  showView('list');
  renderList();
  refreshCatalog(false);
}

/* ------------------------------------------------------------------ */
/* 商品列表                                                            */
/* ------------------------------------------------------------------ */

async function loadCatalog() {
  const data = await api('/api/catalog', { auth: false });
  state.catalog = data.items || [];
  state.loaded = true;
  state.loadFailed = false;
  if (state.view === 'list') renderList();
  if (state.view === 'detail') renderDetail();
}

async function refreshCatalog(showError = true) {
  try {
    await loadCatalog();
  } catch (e) {
    state.loaded = true;
    state.loadFailed = true;
    if (state.view === 'list') renderList();
    if (showError) toast(e.message, 'err');
  }
}

function matches(item, keyword) {
  const key = String(keyword || '').trim().toLowerCase();
  if (!key) return true;
  return (
    String(item.model).toLowerCase().includes(key) ||
    String(item.pattern).toLowerCase().includes(key) ||
    String(item.series).toLowerCase().includes(key)
  );
}

const listState = { shown: [] };

function renderList() {
  const box = $('listBody');
  const meta = $('listMeta');
  box.textContent = '';

  if (!state.loaded) {
    meta.textContent = '';
    box.appendChild(el('div', 'empty', '正在加载…'));
    return;
  }

  const keyword = state.keyword.trim();
  const hits = state.catalog.filter((item) => matches(item, keyword));
  const inStock = hits.filter((item) => item.quantity > 0).length;
  listState.shown = hits;

  if (!state.catalog.length) {
    meta.textContent = state.loadFailed ? '' : '';
  } else if (keyword) {
    meta.textContent = `找到 ${hits.length} 个规格，其中 ${inStock} 个有库存`;
  } else {
    const withStock = state.catalog.filter((i) => i.quantity > 0).length;
    meta.textContent = `共 ${state.catalog.length} 个规格，${withStock} 个有库存`;
  }

  if (!hits.length) {
    const empty = el('div', 'empty');
    if (state.loadFailed && !state.catalog.length) empty.textContent = '没加载出来，检查网络后点下面的「刷新」';
    else if (!state.catalog.length) empty.textContent = '还没有价格表数据，请管理员先导入价格表';
    else empty.textContent = '没有找到匹配的规格';
    box.appendChild(empty);
    $('moreBtn').hidden = true;
    return;
  }

  const frag = document.createDocumentFragment();
  for (const item of hits.slice(0, state.limit)) frag.appendChild(renderRow(item, keyword));
  box.appendChild(frag);

  const rest = hits.length - state.limit;
  $('moreBtn').hidden = rest <= 0;
  if (rest > 0) $('moreBtn').textContent = `还有 ${rest} 个规格，显示更多`;
}

function renderRow(item, keyword) {
  const row = el('button', 'item');
  row.type = 'button';
  row.onclick = () => {
    location.hash = `#/p/${encodeURIComponent(item.model)}/${encodeURIComponent(item.pattern)}`;
  };

  const top = el('div', 'row-top');
  const model = el('span', 'model');
  highlight(model, item.model, keyword);
  top.appendChild(model);
  if (item.pattern) {
    const pattern = el('span', 'pattern');
    highlight(pattern, item.pattern, keyword);
    top.appendChild(pattern);
  }

  // 没有库存就整块不显示
  if (item.quantity > 0) top.appendChild(el('span', 'qty', `${item.quantity} 条`));
  row.appendChild(top);

  const sub = el('div', 'row-sub');
  if (item.series) {
    const series = el('span', 'series');
    highlight(series, item.series, keyword);
    sub.appendChild(series);
  }
  if (item.storePrice !== null && item.storePrice !== undefined) {
    sub.appendChild(el('span', 'price', `门店 ${money(item.storePrice)}`));
  }
  if (item.netPrice !== null && item.netPrice !== undefined) {
    sub.appendChild(el('span', 'price', `京东 ${money(item.netPrice)}`));
  }
  if (sub.childNodes.length) row.appendChild(sub);

  return row;
}

/* ------------------------------------------------------------------ */
/* 商品详情                                                            */
/* ------------------------------------------------------------------ */

function findItem(model, pattern) {
  return state.catalog.find((i) => i.model === model && String(i.pattern || '') === String(pattern || ''));
}

function renderDetail() {
  const view = $('view-detail');
  view.textContent = '';

  const { model, pattern } = state.current || {};
  const item = findItem(model, pattern);

  const card = el('div', 'card detail-head');
  card.appendChild(el('div', 'detail-model', model || ''));
  if (pattern) card.appendChild(el('div', 'detail-pattern', pattern));

  if (item && item.quantity > 0) {
    const stock = el('div', 'detail-stock');
    stock.appendChild(el('span', 'detail-stock-label', '当前库存'));
    stock.appendChild(el('span', 'detail-stock-value', `${item.quantity} 条`));
    card.appendChild(stock);
  }
  view.appendChild(card);

  if (!item) {
    const note = el('div', 'card');
    note.appendChild(el('p', 'hint', '价格表里没有这个规格，可能库存是单独录入的。'));
    view.appendChild(note);
    return;
  }

  // 没录的字段整行不出现
  const fields = [
    ['系列', item.series],
    ['花纹', item.pattern],
    ['门店价格', item.storePrice !== null && item.storePrice !== undefined ? money(item.storePrice) : ''],
    ['京东价格', item.netPrice !== null && item.netPrice !== undefined ? money(item.netPrice) : ''],
  ].filter(([, value]) => value !== null && value !== undefined && String(value) !== '');

  if (fields.length) {
    const info = el('div', 'card');
    const dl = el('dl', 'fields');
    for (const [label, value] of fields) {
      const wrap = el('div', 'field');
      wrap.appendChild(el('dt', null, label));
      wrap.appendChild(el('dd', null, String(value)));
      dl.appendChild(wrap);
    }
    info.appendChild(dl);
    view.appendChild(info);
  }

  if (item.quantity > 0) {
    const tip = el('div', 'card tip');
    tip.appendChild(el('p', null, '有货，可以直接联系店家下单。'));
    view.appendChild(tip);
  }
}

/* ------------------------------------------------------------------ */
/* 登录                                                                */
/* ------------------------------------------------------------------ */

async function doLogin() {
  if (state.busy) return;
  const password = $('loginPassword').value.trim();
  if (!password) {
    toast('请输入管理口令', 'err');
    return;
  }

  overlay(true, '校验中…');
  try {
    const data = await api('/api/login', { method: 'POST', body: { password }, auth: false });
    state.token = data.token;
    state.who = { name: data.name, role: data.role };
    saveSession();
    $('loginPassword').value = '';
    toast(`欢迎，${data.name}`);
    showView('admin');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    overlay(false);
  }
}

function logout() {
  clearSession();
  toast('已退出登录');
  location.hash = '#/';
}

function renderAdmin() {
  const isSuper = state.who && state.who.role === 'super';
  $('adminWho').textContent = state.who ? state.who.name : '';
  $('adminRole').textContent = isSuper ? '超级管理员' : '管理员';
  $('adminManageCard').hidden = !isSuper;
  if (isSuper) loadAdmins().catch((e) => toast(e.message, 'err'));
  loadMovements();
  loadPriceLists();
}

/* ------------------------------------------------------------------ */
/* 单条出入库                                                          */
/* ------------------------------------------------------------------ */

function readOpForm() {
  return {
    model: $('opModel').value.trim(),
    pattern: $('opPattern').value.trim(),
    quantity: $('opQty').value.trim(),
    unitPrice: $('opPrice').value.trim(),
  };
}

function clearOpForm() {
  for (const id of ['opModel', 'opPattern', 'opQty', 'opPrice']) $(id).value = '';
  $('opModel').focus();
}

async function submitOp(action) {
  if (state.busy) return;

  const form = readOpForm();
  const qty = Number(form.quantity);
  if (!form.model || form.quantity === '' || !Number.isFinite(qty) || !Number.isInteger(qty) || qty <= 0) {
    toast('请填写完整的入库/出库信息', 'err');
    return;
  }

  overlay(true, action === 'in' ? '入库中…' : '出库中…');
  try {
    const data = await api('/api/stock/' + action, { method: 'POST', body: form });
    toast(data.message || (action === 'in' ? '入库成功' : '出库成功'));
    clearOpForm();
    await loadCatalog();
    loadMovements();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    overlay(false);
  }
}

/* ------------------------------------------------------------------ */
/* 选文件 → 预览 → 确认                                                */
/* ------------------------------------------------------------------ */

async function pickFile(kind, file) {
  if (!file || state.busy) return;

  overlay(true, '读取文件…');
  let parsed;
  try {
    const rows = await readTableFile(file);
    parsed = finishParse(kind, rows, file.name || '');
  } catch (e) {
    toast(e.message, 'err');
    return;
  } finally {
    overlay(false);
  }

  applyParsed(kind, parsed);
}

/** 选不到文件时，直接把表格内容粘进来 */
function pickText(kind, text) {
  if (!text || !text.trim()) {
    toast('先把表格内容粘进来', 'err');
    return;
  }
  let parsed;
  try {
    parsed = finishParse(kind, parseCsvText(text), '粘贴的内容');
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  applyParsed(kind, parsed);
}

function finishParse(kind, rows, fileName) {
  const parsed = kind === 'price' ? buildPriceRows(rows) : buildStockRows(rows);
  parsed.fileName = fileName;
  parsed.badRows = (parsed.rows || []).filter((r) => r.error);
  parsed.goodRows = (parsed.rows || []).filter((r) => !r.error);
  return parsed;
}

function applyParsed(kind, parsed) {
  state.parsed[kind] = parsed;
  if (kind === 'price' && !$('priceListName').value.trim()) {
    // 文件名和已有价格表差不多时，自动对上，避免又建出一份新的
    const guessed = guessPriceListName(parsed.fileName);
    $('priceListName').value = matchExistingList(guessed) || guessed;
  }
  updatePriceListHint();
  renderPreview(kind);
}

/* ------------------------------------------------------------------ */
/* 价格表名称：已有哪几份，这次会替换哪一份                              */
/* ------------------------------------------------------------------ */

async function loadPriceLists() {
  try {
    const data = await api('/api/pricelists');
    state.priceLists = data.items || [];
  } catch (e) {
    state.priceLists = [];
  }
  renderPriceListChips();
}

function matchExistingList(name) {
  const target = String(name || '').trim();
  if (!target) return '';
  const exact = state.priceLists.find((p) => p.name === target);
  if (exact) return exact.name;
  const partial = state.priceLists.find((p) => target.includes(p.name) || p.name.includes(target));
  return partial ? partial.name : '';
}

function renderPriceListChips() {
  const box = $('priceListChips');
  const options = $('priceListOptions');
  box.textContent = '';
  options.textContent = '';

  for (const item of state.priceLists) {
    const option = document.createElement('option');
    option.value = item.name;
    options.appendChild(option);

    const chip = el('button', 'chip', `${item.name}（${item.count}）`);
    chip.type = 'button';
    chip.onclick = () => {
      $('priceListName').value = item.name;
      updatePriceListHint();
    };
    box.appendChild(chip);
  }
  box.hidden = !state.priceLists.length;
  updatePriceListHint();
}

function updatePriceListHint() {
  const hint = $('priceListHint');
  const name = $('priceListName').value.trim();

  if (!state.priceLists.length) {
    hint.textContent = '现在还没有价格表，这次导入就是第一份。';
    return;
  }
  if (!name) {
    hint.textContent = '选文件后会自动填；也可以直接点上面的名字。';
    return;
  }

  const hit = state.priceLists.find((p) => p.name === name);
  if (hit) {
    hint.textContent = `会整份替换「${hit.name}」原来的 ${hit.count} 行，其他价格表不动。`;
  } else {
    hint.textContent = `「${name}」是个新名字，会和已有的${state.priceLists
      .map((p) => `「${p.name}」`)
      .join('、')}并存，不会替换它们。`;
  }
}

function renderPreview(kind) {
  const box = $(kind + 'Preview');
  const parsed = state.parsed[kind];
  box.textContent = '';
  if (!parsed) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const total = parsed.goodRows.length;
  const bad = parsed.badRows.length;
  const skipped = parsed.skipped || 0;

  const title = el('div', 'preview-title');
  title.appendChild(el('strong', null, parsed.fileName || '已选择文件'));
  title.appendChild(el('span', 'preview-count', total + ' 行可导入'));
  box.appendChild(title);

  const facts = [];
  facts.push(`表头在第 ${parsed.headerLine} 行，识别到的列：${parsed.columns.join('、')}`);
  if (bad) facts.push(`${bad} 行有问题，导入时会跳过并列出来`);
  if (skipped) facts.push(`${skipped} 行没有规格，已跳过（表尾的说明文字）`);
  for (const w of parsed.warnings || []) facts.push(w);

  const meta = el('ul', 'preview-meta');
  for (const f of facts) meta.appendChild(el('li', null, f));
  box.appendChild(meta);

  const sample = parsed.goodRows.slice(0, 3);
  if (sample.length) {
    const table = el('div', 'preview-sample');
    for (const r of sample) {
      const line = kind === 'price'
        ? `${r.model}｜${r.pattern || '—'}｜${r.series || '—'}｜${r.storePrice || '—'}｜${r.netPrice || '—'}`
        : `${r.model}｜${r.pattern || '—'}｜${r.quantity}｜${r.unitPrice || '—'}`;
      table.appendChild(el('div', 'preview-line', line));
    }
    box.appendChild(table);
  }

  const actions = el('div', 'modal-actions');
  const confirm = el('button', 'btn primary', kind === 'price' ? '确认导入' : kind === 'in' ? '确认入库' : '确认出库');
  confirm.type = 'button';
  confirm.disabled = total === 0;
  confirm.onclick = () => runImport(kind);
  const cancel = el('button', 'btn ghost', '取消');
  cancel.type = 'button';
  cancel.onclick = () => clearPreview(kind);
  actions.appendChild(confirm);
  actions.appendChild(cancel);
  box.appendChild(actions);
}

function clearPreview(kind) {
  state.parsed[kind] = null;
  $(kind + 'Preview').hidden = true;
  $(kind + 'File').value = '';
}

async function runImport(kind) {
  const parsed = state.parsed[kind];
  if (!parsed || state.busy) return;

  if (kind === 'price') await runPriceImport(parsed);
  else await runStockImport(kind, parsed);
}

async function runStockImport(kind, parsed) {
  const action = kind === 'in' ? 'in' : 'out';
  const rows = parsed.goodRows;
  const failures = parsed.badRows.map((r) => `第 ${r.line} 行：${r.error}`);
  let success = 0;

  overlay(true, '导入中…');
  const progress = $('importProgress');
  progress.hidden = false;
  try {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const chunk = rows.slice(i, i + BATCH_SIZE);
      progress.textContent = `正在处理 ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} 行…`;
      const data = await api('/api/stock/import', {
        method: 'POST',
        body: { action, rows: chunk.map(toStockPayload) },
      });
      success += data.success || 0;
      for (const err of data.errors || []) failures.push(`第 ${chunk[err.index].line} 行：${err.reason}`);
    }
  } catch (e) {
    failures.push('导入中断：' + e.message);
  } finally {
    overlay(false);
    progress.hidden = true;
    progress.textContent = '';
  }

  clearPreview(kind);
  await loadCatalog().catch(() => {});
  loadMovements();

  showModal({
    title: action === 'in' ? '入库完成' : '出库完成',
    message: `成功 ${success} 行，失败 ${failures.length} 行`,
    details: failures,
    tone: failures.length ? 'warn' : '',
  });
}

async function runPriceImport(parsed) {
  const priceList = $('priceListName').value.trim() || guessPriceListName(parsed.fileName) || '未命名价格表';
  const rows = parsed.goodRows.map(toPricePayload);

  const yes = await confirmModal(
    `导入「${priceList}」共 ${rows.length} 行，会替换掉这个价格表原有的数据。其他价格表不受影响。`,
    { title: '确认导入价格表', okText: '导入' },
  );
  if (!yes) return;

  overlay(true, '导入价格表…');
  try {
    const data = await api('/api/products/import', { method: 'POST', body: { priceList, rows } });
    clearPreview('price');
    await loadCatalog().catch(() => {});
    showModal({
      title: '价格表导入完成',
      message: `「${data.priceList}」导入了 ${data.imported} 行，价格表里现在共 ${data.total} 行。`,
    });
    if (state.view === 'admin') renderAdmin();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    overlay(false);
  }
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

function exportRows() {
  const onlyStock = $('exportScope').value === 'stock';
  const rows = [['规格', '系列', '花纹', '门店价格', '京东价格', '库存']];
  for (const item of state.catalog) {
    if (onlyStock && !(item.quantity > 0)) continue;
    rows.push([
      item.model,
      item.series || '',
      item.pattern || '',
      item.storePrice === null || item.storePrice === undefined ? '' : item.storePrice,
      item.netPrice === null || item.netPrice === undefined ? '' : item.netPrice,
      item.quantity > 0 ? item.quantity : '',
    ]);
  }
  return rows;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function doExport() {
  if (state.busy) return;
  if (!state.catalog.length) {
    toast('还没有可导出的数据', 'err');
    return;
  }

  const format = $('exportFormat').value;
  const rows = exportRows();
  const stamp = new Date().toISOString().slice(0, 10);
  const base = `轮胎库存_${stamp}`;

  overlay(true, '导出中…');
  try {
    if (format === 'xlsx') {
      const XLSX = await (await import('./table-file.js')).loadSheetJs();
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      const book = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(book, sheet, '库存');
      const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' });
      downloadBlob(new Blob([out], { type: 'application/octet-stream' }), base + '.xlsx');
    } else {
      const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), base + '.csv');
      $('exportText').value = csv.replace(/^\uFEFF/, '');
      $('exportFallback').hidden = false;
    }
    toast(`已导出 ${rows.length - 1} 行`);
  } catch (e) {
    toast('导出失败：' + e.message, 'err');
  } finally {
    overlay(false);
  }
}

/* ------------------------------------------------------------------ */
/* 出入库流水                                                          */
/* ------------------------------------------------------------------ */

async function loadMovements() {
  if (!state.token) return;
  const box = $('movementList');
  if (!box) return;
  try {
    const data = await api('/api/movements?limit=8');
    const items = data.items || [];
    box.textContent = '';
    if (!items.length) {
      box.appendChild(el('div', 'empty', '还没有出入库记录'));
      return;
    }
    for (const m of items) {
      const row = el('div', 'move-row');
      const left = el('div', 'move-main');
      const head = el('div', 'move-head');
      head.appendChild(el('span', 'move-action ' + (m.action === 'in' ? 'is-in' : 'is-out'), m.action === 'in' ? '入库' : '出库'));
      head.appendChild(el('span', 'move-model', m.model + (m.pattern ? ' · ' + m.pattern : '')));
      left.appendChild(head);
      left.appendChild(el('div', 'move-sub', `${String(m.createdAt || '').slice(0, 16).replace('T', ' ')}${m.operator ? ' · ' + m.operator : ''}`));
      row.appendChild(left);
      const right = el('div', 'move-right');
      right.appendChild(el('div', 'move-qty', `${m.action === 'in' ? '+' : '-'}${m.quantity}`));
      if (m.unitPrice !== null && m.unitPrice !== undefined) right.appendChild(el('div', 'move-price', money(m.unitPrice)));
      row.appendChild(right);
      box.appendChild(row);
    }
  } catch (e) {
    box.textContent = '';
    box.appendChild(el('div', 'empty', e.message));
  }
}

/* ------------------------------------------------------------------ */
/* 管理员权限移交                                                      */
/* ------------------------------------------------------------------ */

async function loadAdmins() {
  const data = await api('/api/admins');
  const box = $('adminList');
  box.textContent = '';

  const items = data.items || [];
  if (!items.length) {
    box.appendChild(el('div', 'empty', '还没有普通管理员'));
    return;
  }

  for (const admin of items) {
    const row = el('div', 'admin-row');
    const info = el('div', 'admin-info');
    info.appendChild(el('div', 'admin-name', admin.name));
    info.appendChild(el('div', 'admin-time', '添加于 ' + String(admin.createdAt || '').slice(0, 10)));

    const del = el('button', 'btn danger small', '移除');
    del.type = 'button';
    del.onclick = async () => {
      const yes = await confirmModal(`确定移除管理员「${admin.name}」吗？他手上的登录状态会立刻失效。`, {
        title: '移除管理员',
        okText: '移除',
        danger: true,
      });
      if (!yes) return;
      overlay(true, '处理中…');
      try {
        await api('/api/admins/' + admin.id, { method: 'DELETE' });
        toast('已移除该管理员');
        await loadAdmins();
      } catch (e) {
        toast(e.message, 'err');
      } finally {
        overlay(false);
      }
    };

    row.appendChild(info);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function addAdmin() {
  if (state.busy) return;
  const name = $('newAdminName').value.trim();
  const password = $('newAdminPassword').value.trim();
  if (!name) {
    toast('请填写管理员名称', 'err');
    return;
  }
  if (password.length < 6) {
    toast('登录口令至少 6 位', 'err');
    return;
  }

  overlay(true, '添加中…');
  try {
    const data = await api('/api/admins', { method: 'POST', body: { name, password } });
    toast(data.message || '已添加管理员');
    $('newAdminName').value = '';
    $('newAdminPassword').value = '';
    await loadAdmins();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    overlay(false);
  }
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */

function bindEvents() {
  const search = $('searchInput');
  search.value = state.keyword;
  $('clearSearchBtn').hidden = !state.keyword;

  const onSearch = () => {
    state.keyword = search.value;
    state.limit = PAGE_SIZE;
    localStorage.setItem('tire_keyword', state.keyword);
    $('clearSearchBtn').hidden = !state.keyword;
    renderList();
  };
  search.addEventListener('input', onSearch);
  $('clearSearchBtn').onclick = () => {
    search.value = '';
    onSearch();
    search.focus();
  };

  $('refreshBtn').onclick = async () => {
    $('refreshBtn').disabled = true;
    await refreshCatalog(true);
    if (!state.loadFailed) toast('已刷新');
    $('refreshBtn').disabled = false;
  };

  $('moreBtn').onclick = () => {
    state.limit += PAGE_SIZE;
    renderList();
  };

  $('backBtn').onclick = () => {
    location.hash = '#/';
  };
  $('adminEntryBtn').onclick = () => {
    location.hash = '#/admin';
  };

  $('loginBtn').onclick = doLogin;
  $('loginPassword').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') doLogin();
  });
  $('logoutBtn').onclick = logout;

  $('stockInBtn').onclick = () => submitOp('in');
  $('stockOutBtn').onclick = () => submitOp('out');

  for (const kind of ['in', 'out', 'price']) {
    $(kind + 'PickBtn').onclick = () => $(kind + 'File').click();
    $(kind + 'File').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (file) pickFile(kind, file);
    });
  }

  for (const kind of ['in', 'out']) {
    $(kind + 'TextBtn').onclick = () => {
      pickText(kind, $(kind + 'Text').value);
      $(kind + 'Text').value = '';
    };
  }

  $('priceListName').addEventListener('input', updatePriceListHint);

  $('exportBtn').onclick = doExport;
  $('addAdminBtn').onclick = addAdmin;

  window.addEventListener('hashchange', route);
}

function start() {
  bindEvents();
  route();
}

start();
