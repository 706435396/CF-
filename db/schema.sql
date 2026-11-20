-- ============================================================
-- 小说自动发货系统 · Cloudflare D1 数据库结构
-- 建库命令：
--   npx wrangler d1 create novel-shop-db
--   npx wrangler d1 execute novel-shop-db --file=./db/schema.sql --remote
-- ============================================================

-- 商品（小说）表
CREATE TABLE IF NOT EXISTS products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,              -- 路由标识 /novel/:slug
  title         TEXT NOT NULL,                     -- 书名
  author        TEXT DEFAULT '佚名',
  category      TEXT DEFAULT '其他',               -- 分类
  description   TEXT DEFAULT '',                   -- 简介
  cover_url     TEXT DEFAULT '',                   -- 封面图 URL（可选）
  price         INTEGER NOT NULL DEFAULT 0,        -- 价格（单位：分）
  original_price INTEGER DEFAULT 0,                -- 划线价（分）
  file_name     TEXT DEFAULT '',                   -- 原始文件名
  file_size     INTEGER DEFAULT 0,                 -- 文件大小（字节）
  file_format   TEXT DEFAULT 'txt',                -- txt / epub / md / pdf
  r2_key        TEXT DEFAULT '',                   -- R2 存储对象 key
  drive_url     TEXT DEFAULT '',                   -- 网盘直链（发货方式之一）
  content       TEXT DEFAULT '',                   -- 正文（短篇可直接存，用于在线阅读）
  status        TEXT DEFAULT 'on',                -- on 上架 / off 下架
  sales         INTEGER DEFAULT 0,                 -- 销量
  created_at    INTEGER NOT NULL,                  -- unix ms
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

-- 订单表
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no        TEXT UNIQUE NOT NULL,            -- 平台订单号 NVSHOPxxxx
  product_id      INTEGER NOT NULL,
  product_title   TEXT DEFAULT '',
  amount          INTEGER NOT NULL,                -- 实付金额（分）
  pay_channel     TEXT DEFAULT 'epay',             -- 支付通道标识（可插拔）
  pay_type        TEXT DEFAULT 'alipay',           -- alipay / wechat / qq ...
  status          TEXT DEFAULT 'pending',          -- pending/paid/expired/refunded
  trade_no        TEXT DEFAULT '',                 -- 第三方交易号
  email           TEXT DEFAULT '',                 -- 收货邮箱
  delivery_method TEXT DEFAULT 'link',             -- link / read / email / all
  read_token      TEXT DEFAULT '',                 -- 在线阅读令牌
  delivered_at    INTEGER,                         -- 发货时间
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  FOREIGN KEY (product_id) REFERENCES products(id)
);
CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders(order_no);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- 发货记录表（每次发货一条，邮件失败可追溯补发）
CREATE TABLE IF NOT EXISTS deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no    TEXT NOT NULL,
  product_id  INTEGER,
  method      TEXT NOT NULL,                       -- link / read / email
  target      TEXT DEFAULT '',                     -- 邮箱或令牌
  content     TEXT DEFAULT '',                     -- 发货内容快照（链接等）
  status      TEXT DEFAULT 'success',              -- success / failed
  error       TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_order ON deliveries(order_no);

-- 卡密表（预留：卡密兑换模式）
CREATE TABLE IF NOT EXISTS cards (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL,
  code        TEXT UNIQUE NOT NULL,                -- 卡密
  status      TEXT DEFAULT 'unused',               -- unused / used
  order_no    TEXT DEFAULT '',
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_product ON cards(product_id, status);

-- 管理会话表（简易后台鉴权）
CREATE TABLE IF NOT EXISTS admin_sessions (
  token       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

-- 站点配置表（KV 的 SQL 兜底，可选）
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT DEFAULT ''
);
