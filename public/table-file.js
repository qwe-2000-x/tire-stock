/**
 * 表格文件读取与解析：.csv / .xls / .xlsx 三种都认。
 *
 * .csv 用自带的解析器（能处理 GBK 和 BOM）；
 * .xls / .xlsx 按需加载 SheetJS（public/vendor/xlsx.core.min.js），
 * 普通查库存的人不会下载这个文件。
 */

import { decodeCsvBytes, norm, parseCsvText } from './csv.js';

export { parseCsvText };

/* ------------------------------------------------------------------ */
/* 表头识别规则                                                        */
/* ------------------------------------------------------------------ */

const MODEL = {
  label: '规格',
  aliases: ['规格', '型号', '商品名称', '规格型号', '规格&速级负荷', '规格速级负荷', 'model', 'size'],
};
const PATTERN = { label: '花纹', aliases: ['花纹', '商品花纹', 'pattern'] };

const STOCK_SPEC = {
  model: MODEL,
  pattern: PATTERN,
  quantity: { label: '数量', aliases: ['数量', '库存', '库存数量', 'quantity', '数'] },
  unitPrice: { label: '单价', aliases: ['单价', '价格', 'unitprice', 'price', '进货价', '出货价'] },
};

const PRICE_SPEC = {
  model: MODEL,
  pattern: PATTERN,
  series: { label: '系列', aliases: ['系列', 'series', '品牌'] },
  storePrice: {
    label: '门店价格',
    aliases: ['门店价格', '给门店价格', '门店价', '门市价', '零售价', '门店零售价', 'storeprice'],
  },
  netPrice: {
    label: '京东价格',
    aliases: ['京东价格', '京东价', '京东', '京东/天猫', '京东天猫', '网络价', 'netprice'],
  },
};

/* ------------------------------------------------------------------ */
/* 读取文件                                                            */
/* ------------------------------------------------------------------ */

let sheetJsPromise = null;

/** 按需加载 SheetJS；Node 测试里可以直接预置 globalThis.XLSX */
export function loadSheetJs() {
  if (globalThis.XLSX) return Promise.resolve(globalThis.XLSX);
  if (typeof document === 'undefined') {
    return Promise.reject(new Error('当前环境不能加载表格解析库'));
  }
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/xlsx.core.min.js';
      script.onload = () => {
        if (globalThis.XLSX) resolve(globalThis.XLSX);
        else reject(new Error('表格解析库加载失败'));
      };
      script.onerror = () => {
        sheetJsPromise = null;
        reject(new Error('表格解析库加载失败，请检查网络后重试'));
      };
      document.head.appendChild(script);
    });
  }
  return sheetJsPromise;
}

/** 用 SheetJS 读 xls / xlsx（也能读被改成 .csv 的 HTML 表格） */
export async function readWithSheetJs(buffer) {
  const XLSX = await loadSheetJs();
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error('这个文件里没有工作表');
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  return rows.map((row) =>
    (row || []).map((cell) => {
      if (cell === null || cell === undefined) return '';
      if (cell instanceof Date) return cell.toISOString().slice(0, 10);
      return String(cell).trim();
    }),
  );
}

/**
 * 把选中的文件读成二维字符串数组。
 * @param {{name?: string, arrayBuffer: () => Promise<ArrayBuffer>}} file
 */
export async function readTableFile(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = decodeCsvBytes(bytes);
    // 有些系统导出的"csv"其实是 HTML 表格，交给 SheetJS 兜底
    if (!/^\s*</.test(text)) return parseCsvText(text);
  }
  return await readWithSheetJs(buffer);
}

/* ------------------------------------------------------------------ */
/* 表头与数据行                                                        */
/* ------------------------------------------------------------------ */

function matchColumn(cell, spec) {
  const key = norm(cell);
  if (!key) return null;
  for (const field of Object.keys(spec)) {
    if (spec[field].aliases.some((alias) => norm(alias) === key)) return field;
  }
  return null;
}

function findHeader(rows, spec, requiredKeys) {
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const cells = rows[i] || [];
    const index = {};
    cells.forEach((cell, j) => {
      const field = matchColumn(cell, spec);
      if (field && index[field] === undefined) index[field] = j;
    });
    if (requiredKeys.every((k) => index[k] !== undefined)) return { rowIndex: i, index };
  }
  return null;
}

function toInt(value) {
  const s = String(value ?? '').replace(/[\s,，]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

function makeReader(rows, header) {
  const index = header.index;
  return (cells, field) => {
    if (index[field] === undefined) return '';
    return String((cells || [])[index[field]] ?? '').trim();
  };
}

/**
 * 出入库文件：必需「规格」「数量」，可选「花纹」「单价」。
 * 单行出问题只标记这行，不影响其他行。
 */
export function buildStockRows(rows) {
  const header = findHeader(rows, STOCK_SPEC, ['model', 'quantity']);
  if (!header) {
    const partial = findHeader(rows, STOCK_SPEC, ['model']);
    if (partial) throw new Error('这个文件缺少「数量」列');
    throw new Error('认不出表头：文件里至少要有「规格」和「数量」两列');
  }

  const warnings = [];
  if (header.index.pattern === undefined) warnings.push('文件里没有「花纹」列，这一批按无花纹处理');
  if (header.index.unitPrice === undefined) warnings.push('文件里没有「单价」列，这一批不记录单价');

  const read = makeReader(rows, header);
  const out = [];

  for (let r = header.rowIndex + 1; r < rows.length; r += 1) {
    const cells = rows[r] || [];
    const item = {
      line: r + 1,
      model: read(cells, 'model'),
      pattern: read(cells, 'pattern'),
      quantity: read(cells, 'quantity'),
      unitPrice: read(cells, 'unitPrice'),
      error: '',
    };

    const filled = [item.model, item.pattern, item.quantity, item.unitPrice].filter((v) => v !== '').length;
    if (filled === 0) continue;                                  // 空行
    if (!item.model && filled <= 1) continue;                    // 表尾的署名、日期之类

    if (!item.model) {
      item.error = '缺少规格';
    } else {
      const qty = toInt(item.quantity);
      if (qty === null || qty <= 0) item.error = '数量必须是大于 0 的整数';
      else item.quantity = qty;
    }
    out.push(item);
  }

  return {
    rows: out,
    warnings,
    headerLine: header.rowIndex + 1,
    columns: Object.keys(header.index).map((k) => STOCK_SPEC[k].label),
  };
}

/**
 * 价格表文件：必需「规格」，至少要有一列价格；系列、花纹、京东价都可以缺。
 * 没有规格的行（表头的标题、表尾的署名）直接跳过。
 */
export function buildPriceRows(rows) {
  const hasPriceKey = (index) => index.storePrice !== undefined || index.netPrice !== undefined;

  let header = null;
  for (let i = 0; i < Math.min(rows.length, 25); i += 1) {
    const cells = rows[i] || [];
    const index = {};
    cells.forEach((cell, j) => {
      const field = matchColumn(cell, PRICE_SPEC);
      if (field && index[field] === undefined) index[field] = j;
    });
    if (index.model !== undefined && hasPriceKey(index)) {
      header = { rowIndex: i, index };
      break;
    }
  }

  if (!header) {
    throw new Error('认不出表头：文件里要有「规格」（或商品名称）列，以及「门店价格」或「京东价」列');
  }

  const warnings = [];
  if (header.index.pattern === undefined) warnings.push('文件里没有「花纹」列');
  if (header.index.series === undefined) warnings.push('文件里没有「系列」列');
  if (header.index.storePrice === undefined) warnings.push('文件里没有「门店价格」列');
  if (header.index.netPrice === undefined) warnings.push('文件里没有「京东价格」列');

  const read = makeReader(rows, header);
  const out = [];
  let skipped = 0;

  for (let r = header.rowIndex + 1; r < rows.length; r += 1) {
    const cells = rows[r] || [];
    const item = {
      line: r + 1,
      model: read(cells, 'model'),
      pattern: read(cells, 'pattern'),
      series: read(cells, 'series'),
      storePrice: read(cells, 'storePrice'),
      netPrice: read(cells, 'netPrice'),
    };
    if (!item.model) {
      const filled = Object.values(item).filter((v) => v !== '').length;
      if (filled) skipped += 1;
      continue;
    }
    out.push(item);
  }

  return {
    rows: out,
    warnings,
    skipped,
    headerLine: header.rowIndex + 1,
    columns: Object.keys(header.index).map((k) => PRICE_SPEC[k].label),
  };
}

/** 从文件名猜一个价格表名称，比如「安睿驰价格表.xls」→「安睿驰价格表」 */
export function guessPriceListName(fileName) {
  return String(fileName || '')
    .replace(/\.(csv|xls|xlsx|txt)$/i, '')
    .trim();
}

/** 把解析结果转成发给云端的格式（空字段不发，保证不写库） */
export function toStockPayload(item) {
  const payload = { model: item.model, quantity: item.quantity };
  if (item.pattern) payload.pattern = item.pattern;
  if (item.unitPrice !== '' && item.unitPrice !== undefined) payload.unitPrice = item.unitPrice;
  return payload;
}

export function toPricePayload(item) {
  const payload = { model: item.model };
  if (item.pattern) payload.pattern = item.pattern;
  if (item.series) payload.series = item.series;
  if (item.storePrice !== '') payload.storePrice = item.storePrice;
  if (item.netPrice !== '') payload.netPrice = item.netPrice;
  return payload;
}
