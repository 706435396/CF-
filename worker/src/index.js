/**
 * 私密内容自动发货系统 · Cloudflare Worker 后端入口
 *
 * 隐私设计（重要）：
 *   公开接口一律不返回真实内容身份（书名/作者/简介/封面/文件名/格式/网盘链接/正文）。
 *   买家在付款前只能看到「档案编号 + 分类 + 价格 + 销量」。
 *   付款成功后，订单接口才返回真实标题与下载/阅读链接；阅读链接仍需令牌。
 *
 * 路由：
 *   GET  /api/products              商品列表（脱敏：编号/分类/价格/销量）
 *   GET  /api/products/:code        商品详情（按编号查询，脱敏）
 *   POST /api/orders                创建订单（入参 code，不暴露 slug）
 *   GET  /api/orders/:order_no      查询订单（付款前脱敏 / 付款后含发货信息）
 *   POST /api/pay/notify            支付回调（验签+发货）
 *   GET  /api/pay/return            支付同步跳转
 *   GET  /api/read/:token           在线阅读正文（需令牌）
 *   GET  /api/file/:key             R2 文件下载
 *   POST /api/admin/login           后台登录
 *   GET/POST/PUT/DELETE /api/admin/* 后台管理（登录后才返回完整字段）
 */

import { getAdapter } from './pay/index.js';
import { fulfillOrder, genToken } from './delivery/index.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}
function html(body, status = 200) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS } });
}
function now() { return Date.now(); }
function orderNo() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const rnd = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `NV${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${rnd}`;
}

/* ===== 公开档案编号：仅由 id 派生，不泄露 slug/书名 ===== */
function publicCode(id) { return 'NO.' + String(id).padStart(5, '0'); }
function idFromCode(code) {
  const s = String(code || '').replace(/^NO\.?/i, '').replace(/^#/, '').trim();
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function hashPassword(pwd) {
  const data = new TextEncoder().encode('nvsite#' + pwd);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      return json({ ok: false, error: e.message || '服务器内部错误' }, 500);
    }
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return json({ ok: true });

  // ---------- 公开接口（全部脱敏） ----------
  if (path === '/api/products' && method === 'GET') return listProducts(url, env);
  if (path.startsWith('/api/products/') && method === 'GET') {
    return getProduct(decodeURIComponent(path.split('/')[3]), env);
  }
  if (path === '/api/orders' && method === 'POST') return createOrder(request, env);
  if (path.startsWith('/api/orders/') && method === 'GET') {
    return queryOrder(decodeURIComponent(path.split('/')[3]), request, env);
  }
  if (path === '/api/pay/notify' && (method === 'POST' || method === 'GET')) {
    return payNotify(request, env);
  }
  if (path === '/api/pay/return') return payReturn(url, env);
  if (path.startsWith('/api/read/') && method === 'GET') {
    return readContent(decodeURIComponent(path.split('/')[3]), env);
  }
  if (path.startsWith('/api/file/') && method === 'GET') {
    return serveFile(decodeURIComponent(path.split('/')[3]), env);
  }

  // ---------- 后台接口 ----------
  if (path === '/api/admin/login' && method === 'POST') return adminLogin(request, env);
  if (path.startsWith('/api/admin/')) return adminRoutes(request, env, path, method);

  if (path === '/') return json({ ok: true, name: 'Vault API', version: '1.0' });
  return json({ ok: false, error: 'Not Found' }, 404);
}

/* ================= 商品（公开：脱敏） ================= */
// 白名单：只返回这些字段，杜绝任何内容身份泄露
function maskProduct(p) {
  return {
    code: publicCode(p.id),
    category: p.category || '其他',
    price: p.price,
    original_price: p.original_price || 0,
    sales: p.sales || 0,
    created_at: p.created_at,
  };
}

async function listProducts(url, env) {
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || '20')));
  const category = url.searchParams.get('category') || '';
  const q = (url.searchParams.get('q') || '').trim();
  const offset = (page - 1) * size;

  let where = "status='on'";
  const binds = [];
  if (category && category !== '全部') { where += ' AND category=?'; binds.push(category); }
  // 搜索只按档案编号的数字部分匹配，绝不按书名/作者搜索（否则可被探测）
  if (q) {
    const digits = q.replace(/^NO\.?/i, '').replace(/^#/, '').trim();
    if (/^\d+$/.test(digits)) { where += ' AND id=?'; binds.push(parseInt(digits, 10)); }
    // 非数字搜索词直接忽略，不暴露任何内容
  }

  const { results } = await env.DB.prepare(
    `SELECT id,category,price,original_price,sales,created_at
     FROM products WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).bind(...binds, size, offset).all();
  const cnt = await env.DB.prepare(`SELECT COUNT(*) c FROM products WHERE ${where}`).bind(...binds).first();
  return json({ ok: true, list: results.map(maskProduct), total: cnt.c, page, size });
}

async function getProduct(code, env) {
  const id = idFromCode(code);
  if (!id) return json({ ok: false, error: '档案编号无效' }, 404);
  const p = await env.DB.prepare(
    `SELECT id,category,price,original_price,sales,created_at
     FROM products WHERE id=? AND status='on'`
  ).bind(id).first();
  if (!p) return json({ ok: false, error: '档案不存在或已下架' }, 404);
  return json({ ok: true, product: maskProduct(p) });
}

/* ================= 下单（用编号，不暴露 slug） ================= */
async function createOrder(request, env) {
  const body = await request.json().catch(() => ({}));
  const { code, email, pay_type = 'alipay', delivery_method } = body;
  const id = idFromCode(code);
  if (!id) return json({ ok: false, error: '缺少或无效的档案编号' }, 400);

  const product = await env.DB.prepare('SELECT * FROM products WHERE id=? AND status=?').bind(id, 'on').first();
  if (!product) return json({ ok: false, error: '档案不存在或已下架' }, 404);

  const no = orderNo();
  const channel = env.PAY_CHANNEL || 'epay';
  await env.DB.prepare(
    `INSERT INTO orders (order_no,product_id,product_title,amount,pay_channel,pay_type,status,email,delivery_method,created_at)
     VALUES (?,?,?,?,?,?,'pending',?,?,?)`
  ).bind(no, product.id, product.title, product.price, channel, pay_type, email || '', delivery_method || env.DELIVERY_METHOD || 'all', now()).run();

  const adapter = getAdapter(channel);
  // 收银台商品名也用中性文案，避免在支付平台泄露内容身份
  const clientIp = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || '127.0.0.1';
  const { payUrl } = await adapter.createPayment(
    {
      order_no: no,
      amount: product.price,
      product_title: `私密档案 ${publicCode(product.id)}`,
      pay_type,
      client_ip: clientIp,
    },
    env,
    { notifyBase: new URL(request.url).origin }
  );
  return json({ ok: true, order_no: no, pay_url: payUrl, amount: product.price, code: publicCode(product.id) });
}

/* ================= 支付回调 ================= */
async function payNotify(request, env) {
  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  if (request.method === 'POST') {
    const form = await request.text();
    for (const [k, v] of new URLSearchParams(form).entries()) params[k] = v;
  }
  const channel = env.PAY_CHANNEL || 'epay';
  let verified;
  try {
    verified = await getAdapter(channel).verifyNotify(params, env, {});
  } catch (e) {
    return html('fail');
  }
  if (!verified.ok) return html('fail');

  const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no=?').bind(verified.orderNo).first();
  if (!order) return html('fail');
  if (order.status === 'paid') return html('success'); // 幂等

  // 金额校验
  if (verified.amount && verified.amount !== order.amount) return html('fail');

  await env.DB.prepare(
    "UPDATE orders SET status='paid', trade_no=?, paid_at=? WHERE order_no=?"
  ).bind(verified.tradeNo || '', now(), order.order_no).run();

  await env.DB.prepare('UPDATE products SET sales=sales+1 WHERE id=?').bind(order.product_id).run();

  // 发货
  const product = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(order.product_id).first();
  const freshOrder = await env.DB.prepare('SELECT * FROM orders WHERE order_no=?').bind(order.order_no).first();
  try {
    await fulfillOrder(env, freshOrder, product, request);
    await env.DB.prepare('UPDATE orders SET delivered_at=? WHERE order_no=?').bind(now(), order.order_no).run();
  } catch (e) { /* 发货异常记录，订单仍为已支付，可在后台补发 */ }

  return html('success'); // 易支付要求返回纯文本 success
}

async function payReturn(url, env) {
  const no = url.searchParams.get('order_no') || '';
  // 若配置了前端域名，直接跳转回前端订单页
  if (env.FRONTEND_URL) {
    const base = env.FRONTEND_URL.replace(/\/$/, '');
    return new Response(null, {
      status: 302,
      headers: { Location: `${base}/order.html?order_no=${encodeURIComponent(no)}&from=pay` },
    });
  }
  return html(`<!doctype html><meta charset="utf-8"><title>支付完成</title>
    <div style="max-width:560px;margin:80px auto;font-family:sans-serif;text-align:center">
    <h2>支付已提交</h2><p>订单号：${escapeHtml(no)}</p>
    <p>系统正在确认支付结果，内容将在验证通过后解锁。</p>
    </div>`);
}

/* ================= 订单查询（付款前脱敏 / 付款后揭示） ================= */
async function queryOrder(no, request, env) {
  const order = await env.DB.prepare(
    'SELECT order_no,product_id,amount,pay_type,status,email,delivery_method,read_token,created_at,paid_at,delivered_at FROM orders WHERE order_no=?'
  ).bind(no).first();
  if (!order) return json({ ok: false, error: '订单不存在' }, 404);

  // 基础信息：任何状态下都不包含真实标题，只包含编号
  const result = {
    order_no: order.order_no,
    code: publicCode(order.product_id),
    amount: order.amount,
    pay_type: order.pay_type,
    status: order.status,
    email: order.email,
    created_at: order.created_at,
    paid_at: order.paid_at,
    delivered_at: order.delivered_at,
  };

  // 只有已支付订单才揭示真实内容与链接
  if (order.status === 'paid') {
    const product = await env.DB.prepare(
      'SELECT drive_url,r2_key,title,author,file_format FROM products WHERE id=?'
    ).bind(order.product_id).first();
    const origin = new URL(request.url).origin;
    let downloadUrl = product?.drive_url || '';
    if (!downloadUrl && product?.r2_key && env.FILES) downloadUrl = `${origin}/api/file/${encodeURIComponent(product.r2_key)}`;
    result.product_title = product?.title || '私密档案';
    result.author = product?.author || '';
    result.file_format = product?.file_format || '';
    result.download_url = downloadUrl;
    result.read_url = order.read_token ? `${origin}/read.html?token=${order.read_token}` : '';
  }
  return json({ ok: true, order: result });
}

/* ================= 在线阅读（令牌保护） ================= */
async function readContent(token, env) {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE read_token=? AND status=?').bind(token, 'paid').first();
  if (!order) return json({ ok: false, error: '链接无效或已过期' }, 403);
  const product = await env.DB.prepare('SELECT title,author,content,r2_key FROM products WHERE id=?').bind(order.product_id).first();
  if (!product) return json({ ok: false, error: '内容不存在' }, 404);

  let content = product.content || '';
  if (!content && product.r2_key && env.FILES) {
    const obj = await env.FILES.get(product.r2_key);
    if (obj) content = await obj.text();
  }
  return json({ ok: true, title: product.title, author: product.author, content: content || '（正文暂未录入）' });
}

/* ================= R2 文件 ================= */
async function serveFile(key, env) {
  if (!env.FILES) return json({ ok: false, error: '未配置文件存储' }, 404);
  const obj = await env.FILES.get(key);
  if (!obj) return json({ ok: false, error: '文件不存在' }, 404);
  const ext = key.split('.').pop().toLowerCase();
  const types = { txt: 'text/plain', md: 'text/markdown', epub: 'application/epub+zip', pdf: 'application/pdf' };
  return new Response(obj.body, {
    headers: {
      'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(key.split('/').pop())}"`,
    },
  });
}

/* ================= 后台鉴权与管理（登录后返回完整字段） ================= */
async function adminLogin(request, env) {
  const { password } = await request.json().catch(() => ({}));
  const expected = await hashPassword(env.ADMIN_PASSWORD || 'admin123');
  const input = await hashPassword(password || '');
  if (input !== expected) return json({ ok: false, error: '密码错误' }, 401);
  const token = genToken();
  await env.DB.prepare('INSERT INTO admin_sessions (token,created_at,expires_at) VALUES (?,?,?)')
    .bind(token, now(), now() + 7 * 24 * 3600 * 1000).run();
  return json({ ok: true, token });
}

async function isAdmin(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const s = await env.DB.prepare('SELECT expires_at FROM admin_sessions WHERE token=?').bind(token).first();
  return !!s && s.expires_at > now();
}

async function adminRoutes(request, env, path, method) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '未授权' }, 401);
  const parts = path.split('/').filter(Boolean); // ['api','admin','xxx',id?]
  const resource = parts[2];
  const id = parts[3];

  // 统计
  if (resource === 'stats' && method === 'GET') {
    const p = await env.DB.prepare('SELECT COUNT(*) c FROM products').first();
    const o = await env.DB.prepare('SELECT COUNT(*) c FROM orders').first();
    const paid = await env.DB.prepare("SELECT COUNT(*) c, COALESCE(SUM(amount),0) s FROM orders WHERE status='paid'").first();
    const pending = await env.DB.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending'").first();
    return json({ ok: true, products: p.c, orders: o.c, paid: paid.c, revenue: paid.s, pending: pending.c });
  }

  // 商品管理（完整字段）
  if (resource === 'products') {
    if (method === 'GET' && !id) {
      const { results } = await env.DB.prepare('SELECT * FROM products ORDER BY id DESC').all();
      return json({ ok: true, list: results });
    }
    if (method === 'GET' && id) {
      const p = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(id).first();
      return p ? json({ ok: true, product: p }) : json({ ok: false, error: '不存在' }, 404);
    }
    if (method === 'POST' && !id) {
      const b = await request.json();
      await env.DB.prepare(
        `INSERT INTO products (slug,title,author,category,description,cover_url,price,original_price,file_name,file_size,file_format,r2_key,drive_url,content,status,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(b.slug, b.title, b.author||'佚名', b.category||'其他', b.description||'', b.cover_url||'',
        b.price||0, b.original_price||0, b.file_name||'', b.file_size||0, b.file_format||'txt',
        b.r2_key||'', b.drive_url||'', b.content||'', b.status||'on', now(), now()).run();
      return json({ ok: true });
    }
    if (method === 'PUT' && id) {
      const b = await request.json();
      const fields = ['slug','title','author','category','description','cover_url','price','original_price','file_name','file_size','file_format','r2_key','drive_url','content','status'];
      const sets = fields.filter((f) => b[f] !== undefined).map((f) => `${f}=?`);
      const vals = fields.filter((f) => b[f] !== undefined).map((f) => b[f]);
      sets.push('updated_at=?'); vals.push(now()); vals.push(id);
      await env.DB.prepare(`UPDATE products SET ${sets.join(',')} WHERE id=?`).bind(...vals).run();
      return json({ ok: true });
    }
    if (method === 'DELETE' && id) {
      await env.DB.prepare('DELETE FROM products WHERE id=?').bind(id).run();
      return json({ ok: true });
    }
  }

  // 订单管理
  if (resource === 'orders' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 200').all();
    return json({ ok: true, list: results });
  }

  // 手动补发
  if (resource === 'resend' && method === 'POST' && id) {
    const order = await env.DB.prepare('SELECT * FROM orders WHERE order_no=?').bind(id).first();
    if (!order || order.status !== 'paid') return json({ ok: false, error: '订单未支付' }, 400);
    const product = await env.DB.prepare('SELECT * FROM products WHERE id=?').bind(order.product_id).first();
    const info = await fulfillOrder(env, order, product, request);
    return json({ ok: true, info });
  }

  return json({ ok: false, error: 'Not Found' }, 404);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
