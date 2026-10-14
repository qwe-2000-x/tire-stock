/**
 * 把 SheetJS 的浏览器版复制到 public/vendor/ 下。
 * 用 core 版（427KB）而不是 mini 版，因为 mini 版不支持老式 .xls。
 * 页面只在管理员导入 xls/xlsx 时才按需加载它，普通查库存不受影响。
 *
 * 用法：npm run vendor
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.core.min.js');
const DEST_DIR = path.join(ROOT, 'public', 'vendor');
const DEST = path.join(DEST_DIR, 'xlsx.core.min.js');

if (!fs.existsSync(SRC)) {
  console.error('找不到 ' + SRC);
  console.error('先执行：npm install');
  process.exit(1);
}

fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(SRC, DEST);

const kb = Math.round(fs.statSync(DEST).size / 1024);
console.log(`已复制到 public/vendor/xlsx.core.min.js（${kb} KB）`);
