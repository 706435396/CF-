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

  // ---------- 临时：网关出口IP探测（验证后删除）----------
  if (path === '/api/__probe_gateways' && method === 'GET') {
    const hosts = ['www.ezfpy.cn', 'pay.wewl.net', 'pay.phpwc.com', 'pay.imataoke.com', 'api.kuaixiaopu.com', 'epay.weixii.com'];
    const results = await Promise.all(hosts.map(async (host) => {
      try {
        const resp = await fetch(`https://${host}/mapi.php`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
          body: new URLSearchParams({ pid: '1001', type: 'alipay', out_trade_no: 'PROBE' + Date.now(), name: 'test', money: '1.00', sign: 'bad', sign_type: 'MD5' }).toString(),
        });
        const text = await resp.text();
        let kind = 'other';
        if (/^\s*\{/.test(text)) kind = 'JSON(网关放行)';
        else if (/location\.href|<script|challenge/i.test(text)) kind = 'WAF挑战(拦截)';
        else if (/error code|origin dns/i.test(text)) kind = 'DNS/边缘错误';
        return { host, http: resp.status, kind, body: text.replace(/\s+/g, ' ').trim().slice(0, 80) };
      } catch (e) {
        return { host, http: 0, kind: '请求失败', body: (e.message || '').slice(0, 80) };
      }
    }));
    return json({ ok: true, from: 'worker-egress', results });
  }

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
    return serveFile(decodeURIComponent(path.split('/')[3]), url, env);
  }

  // ---------- 后台接口 ----------
  if (path === '/api/admin/login' && method === 'POST') return adminLogin(request, env);
  if (path === '/api/admin/upload' && method === 'POST') return adminUpload(request, env);
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

  // 一单一码：付款即生成访问令牌，供「在线阅读」与「R2 下载」共用。
  // 即使发货方式只有 link，也有令牌，下载接口据此鉴权。
  const accessToken = order.read_token || genToken();
  await env.DB.prepare(
    "UPDATE orders SET status='paid', trade_no=?, paid_at=?, read_token=? WHERE order_no=?"
  ).bind(verified.tradeNo || '', now(), accessToken, order.order_no).run();

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
    // 兼容历史订单：早期已支付的订单可能没令牌，现场补一个并落库
    let accessToken = order.read_token;
    if (!accessToken) {
      accessToken = genToken();
      await env.DB.prepare('UPDATE orders SET read_token=? WHERE order_no=?').bind(accessToken, order.order_no).run();
    }
    let downloadUrl = product?.drive_url || '';
    // R2 文件走鉴权接口，必须带令牌；网盘直链保持原样（平台自带校验）
    if (!downloadUrl && product?.r2_key && env.FILES) {
      downloadUrl = `${origin}/api/file/${encodeURIComponent(product.r2_key)}?token=${encodeURIComponent(accessToken)}`;
    }
    result.product_title = product?.title || '私密档案';
    result.author = product?.author || '';
    result.file_format = product?.file_format || '';
    result.download_url = downloadUrl;
    result.read_url = `${origin}/read.html?token=${encodeURIComponent(accessToken)}`;
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

/* ================= R2 文件（令牌鉴权） ================= */
async function serveFile(key, url, env) {
  if (!env.FILES) return json({ ok: false, error: '未配置文件存储' }, 404);
  const token = (url.searchParams.get('token') || '').trim();
  if (!token) return json({ ok: false, error: '缺少访问令牌' }, 403);
  // 令牌必须对应一个已支付订单，且该订单的商品确实绑定了这个 key（防越权下载别人的文件）
  const order = await env.DB.prepare(
    "SELECT product_id FROM orders WHERE read_token=? AND status='paid'"
  ).bind(token).first();
  if (!order) return json({ ok: false, error: '令牌无效或订单未支付' }, 403);
  const product = await env.DB.prepare('SELECT r2_key FROM products WHERE id=?').bind(order.product_id).first();
  if (!product || !product.r2_key || product.r2_key !== key) {
    return json({ ok: false, error: '令牌与该文件不匹配' }, 403);
  }
  const obj = await env.FILES.get(key);
  if (!obj) return json({ ok: false, error: '文件不存在' }, 404);
  const ext = key.split('.').pop().toLowerCase();
  const types = { txt: 'text/plain', md: 'text/markdown', epub: 'application/epub+zip', pdf: 'application/pdf' };
  return new Response(obj.body, {
    headers: {
      'Content-Type': (types[ext] || 'application/octet-stream') + '; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(key.split('/').pop())}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/* ================= 后台：上传文件到 R2（管理员鉴权） ================= */
const UPLOAD_TYPES = {
  txt: 'text/plain', md: 'text/markdown', epub: 'application/epub+zip', pdf: 'application/pdf',
};
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // Worker 请求体上限约 100MB

async function adminUpload(request, env) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: '未授权' }, 401);
  if (!env.FILES) return json({ ok: false, error: '未配置文件存储' }, 404);

  let fileName = '', bytes;
  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('multipart/form-data')) {
    // 浏览器表单上传
    const form = await request.formData().catch(() => null);
    const file = form?.get('file');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return json({ ok: false, error: '缺少文件字段 file' }, 400);
    }
    fileName = file.name || 'upload.bin';
    bytes = new Uint8Array(await file.arrayBuffer());
  } else {
    // 原始二进制：文件名从 ?name= 传入
    fileName = new URL(request.url).searchParams.get('name') || 'upload.bin';
    bytes = new Uint8Array(await request.arrayBuffer());
  }

  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (!UPLOAD_TYPES[ext]) {
    return json({ ok: false, error: '仅支持 txt/md/epub/pdf 格式' }, 400);
  }
  if (!bytes.byteLength) return json({ ok: false, error: '文件为空' }, 400);
  if (bytes.byteLength > UPLOAD_MAX_BYTES) {
    return json({ ok: false, error: '文件超过 100MB 限制' }, 413);
  }

  // 随机 key：不可猜、无中文/特殊字符，扩展名保留
  const rand = genToken().slice(0, 24);
  const key = `files/${rand}.${ext}`;
  await env.FILES.put(key, bytes, {
    httpMetadata: { contentType: UPLOAD_TYPES[ext] },
  });
  return json({ ok: true, key, size: bytes.byteLength, ext });
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

  // 商品批量改价（一次请求改多条，支持 固定/增减/倍率 × 选中/分类/全部）
  if (resource === 'batch-price' && method === 'PUT') {
    const b = await request.json().catch(() => ({}));
    const mode = b.mode;                       // fixed | delta | ratio
    const value = Number(b.value);             // fixed=目标价(元), delta=增减(元), ratio=倍率(如0.9)
    const ids = Array.isArray(b.ids) ? b.ids.map(Number).filter(Number.isFinite) : [];
    const category = typeof b.category === 'string' ? b.category.trim() : '';
    const scope = b.scope;                     // ids | category | all

    if (!['fixed','delta','ratio'].includes(mode)) return json({ ok:false, error:'改价方式无效' }, 400);
    if (!Number.isFinite(value)) return json({ ok:false, error:'数值无效' }, 400);
    if (mode === 'fixed' && value < 0) return json({ ok:false, error:'价格不能为负' }, 400);
    if (mode === 'ratio' && (value <= 0 || value > 100)) return json({ ok:false, error:'倍率需在 0~100 之间' }, 400);

    // 先查目标商品（D1 IN 参数上限约 100，超出分批）
    let targets = [];
    if (scope === 'ids') {
      if (!ids.length) return json({ ok:false, error:'未选中商品' }, 400);
      for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const ph = chunk.map(() => '?').join(',');
        const { results } = await env.DB.prepare(`SELECT id,price FROM products WHERE id IN (${ph})`).bind(...chunk).all();
        targets.push(...results);
      }
    } else if (scope === 'category') {
      if (!category) return json({ ok:false, error:'分类不能为空' }, 400);
      const { results } = await env.DB.prepare('SELECT id,price FROM products WHERE category=?').bind(category).all();
      targets = results;
    } else if (scope === 'all') {
      const { results } = await env.DB.prepare('SELECT id,price FROM products').all();
      targets = results;
    } else {
      return json({ ok:false, error:'范围无效' }, 400);
    }
    if (!targets.length) return json({ ok:true, changed:0, message:'没有匹配的商品' });

    // 计算新价（分），批量更新
    const ops = targets.map(p => {
      let cents;
      if (mode === 'fixed') cents = Math.round(value * 100);
      else if (mode === 'delta') cents = Math.max(0, Math.round(Number(p.price || 0) + value * 100));
      else cents = Math.max(0, Math.round(Number(p.price || 0) * value));
      return env.DB.prepare('UPDATE products SET price=?, updated_at=? WHERE id=?').bind(cents, now(), p.id);
    });
    await env.DB.batch(ops);
    return json({ ok:true, changed:ops.length, sample: targets.slice(0,3).map(p => ({ id:p.id, old:p.price })) });
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
