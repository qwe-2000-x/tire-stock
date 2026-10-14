/**
 * CSV 文本解析（纯函数，页面和测试共用这一份）
 *
 * 覆盖：BOM 头、UTF-8/GBK 编码、CRLF/LF/CR 换行、逗号/制表符/分号分隔、
 * 双引号包裹的逗号、"" 转义、空行。
 */

/** 去掉 BOM、空白和全角空格，统一小写，方便比对表头 */
export function norm(text) {
  return String(text ?? '')
    .replace(/\uFEFF/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[（）()]/g, '')
    .toLowerCase();
}

/** 用 UTF-8 解，解不开就退回 GBK */
export function decodeCsvBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    try {
      text = new TextDecoder('gbk').decode(bytes);
    } catch (e2) {
      text = new TextDecoder('utf-8').decode(bytes);
    }
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectDelimiter(text) {
  const firstLine = text.split('\n', 1)[0] || '';
  const count = (re) => (firstLine.match(re) || []).length;
  const commas = count(/,/g);
  const tabs = count(/\t/g);
  const semis = count(/;/g);
  if (tabs > commas && tabs >= semis) return '\t';
  if (semis > commas && semis > tabs) return ';';
  return ',';
}

/** 解析成二维数组，每个单元格都是字符串 */
export function parseCsvText(text, delimiter) {
  const src = String(text ?? '');
  const clean = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  const d = delimiter || detectDelimiter(clean);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < clean.length) {
    const ch = clean[i];

    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"' && field.trim() === '') {
      quoted = true;
      field = '';
      i += 1;
      continue;
    }
    if (ch === d) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  row.push(field);
  rows.push(row);
  return rows;
}
