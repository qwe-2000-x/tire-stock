-- 轮胎库存管理：数据库结构
-- 本地执行：npm run db:local      线上执行：npm run db:remote
-- 灌入两份价格表：npm run db:seed / npm run db:seed:remote

-- 商品价格（来自价格表文件，管理员可以随时整份替换）
CREATE TABLE IF NOT EXISTS products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  model      TEXT    NOT NULL,   -- 规格（商品名称）
  pattern    TEXT,               -- 花纹，没填就是 NULL（前端不显示这一行）
  series     TEXT,               -- 系列
  storePrice REAL,               -- 门店价格
  netPrice   REAL,               -- 京东价格
  priceList  TEXT,               -- 来自哪一份价格表
  updatedAt  TEXT
);

CREATE INDEX IF NOT EXISTS idx_products_model ON products (model);
CREATE INDEX IF NOT EXISTS idx_products_list  ON products (priceList);

-- 库存：按 规格 + 花纹 计
-- warehouse 是给以后"要分仓库"预留的，现在统一存空字符串
CREATE TABLE IF NOT EXISTS stock (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  model     TEXT    NOT NULL,
  pattern   TEXT    NOT NULL DEFAULT '',
  warehouse TEXT    NOT NULL DEFAULT '',
  quantity  INTEGER NOT NULL,
  updatedAt TEXT,
  UNIQUE (model, pattern, warehouse)
);

-- 出入库流水：每笔都记下数量和单价
CREATE TABLE IF NOT EXISTS movements (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  model     TEXT    NOT NULL,
  pattern   TEXT    NOT NULL DEFAULT '',
  quantity  INTEGER NOT NULL,
  unitPrice REAL,
  action    TEXT    NOT NULL,   -- in=入库  out=出库
  operator  TEXT,
  createdAt TEXT
);

CREATE INDEX IF NOT EXISTS idx_movements_id ON movements (id DESC);

-- 管理员名单（超级管理员不在此表，口令存在环境变量里）
CREATE TABLE IF NOT EXISTS admins (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  passHash  TEXT NOT NULL,
  createdAt TEXT
);
