/**
 * 易支付 V1 适配器
 * 兼容两种网关模式（由 EPAY_API_URL 自动判断）：
 *   A) mapi.php —— 服务端 POST 调用，返回 JSON（code/payurl/qrcode/urlscheme），取 payurl 给前端跳转
 *   B) submit.php —— 拼接参数 GET 跳转，浏览器直接打开收银台
 *
 * 签名（两种模式一致，与官方 V1 文档逐条对应）：
 *   1) 所有参数按参数名 ASCII 升序；sign / sign_type / 空值不参与
 *   2) 拼成 k=v&k=v（参数值不做 URL 编码）
 *   3) MD5(拼接串 + 商户密钥 KEY)，结果小写
 *
 * 对外方法（供 index.js 调用）：
 *   createPayment(order, env, config) -> { payUrl, mode, raw }
 *   verifyNotify(params, env, config) -> { ok, tradeNo, amount, orderNo, raw }
 */
import { md5 } from './md5.js';

// 前端支付方式 -> 易支付 V1 的 type 取值（官方文档：alipay/wxpay/qqpay/bank/jdpay/paypal/douyinpay）
const PAY_TYPE_MAP = {
  alipay: 'alipay',
  wechat: 'wxpay', wxpay: 'wxpay', wx: 'wxpay',
  qq: 'qqpay', qqpay: 'qqpay',
  bank: 'bank', jdpay: 'jdpay', paypal: 'paypal', douyinpay: 'douyinpay',
};

function mapPayType(v) {
  return PAY_TYPE_MAP[String(v || '').toLowerCase()] || 'alipay';
}

function buildSign(params, key) {
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type'
      && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join('&') + key;
  return md5(str);
}

function isMapiMode(apiUrl) {
  return /mapi\.php/i.test(apiUrl || '');
}

// 容错：根地址自动补全 mapi.php，避免用户只填域名时误走旧版 GET 跳转模式
function normalizeApiUrl(apiUrl) {
  const raw = String(apiUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return raw;
  if (/\.php$/i.test(raw)) return raw; // 已明确指定 php 接口则不改写
  return `${raw}/mapi.php`;
}

export async function createPayment(order, env, config) {
  const pid = config.pid || env.EPAY_PID;
  const key = config.key || env.EPAY_KEY;
  const apiUrl = normalizeApiUrl(config.apiUrl || env.EPAY_API_URL);
  if (!pid || !key || !apiUrl) throw new Error('易支付配置缺失：请设置 EPAY_PID / EPAY_KEY / EPAY_API_URL');

  const origin = (config.notifyBase || '').replace(/\/$/, '');
  const params = {
    pid: String(pid),
    type: mapPayType(order.pay_type),
    out_trade_no: order.order_no,
    notify_url: `${origin}/api/pay/notify`,
    return_url: `${origin}/api/pay/return?order_no=${order.order_no}`,
    name: order.product_title || '数字内容',
    money: (order.amount / 100).toFixed(2), // 易支付金额单位为元，最大 2 位小数
    clientip: order.client_ip || '127.0.0.1', // 官方文档必填
    param: order.param || order.order_no,
    sign_type: 'MD5',
  };
  params.sign = buildSign(params, key);

  // ---- 模式 A：mapi.php 服务端 POST，返回 JSON ----
  if (isMapiMode(apiUrl)) {
    let data;
    const postBody = new URLSearchParams(params).toString();
    const post = (cookie) => fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: postBody,
    });
    try {
      let resp = await post();
      let raw = await resp.text();
      // 部分网关 WAF 对 CF 出口 IP 首次返回 JS 挑战页（403/200 + location.href 跳转 + Set-Cookie）
      // 带首次响应种下的 Cookie 重试一次，模拟浏览器二次访问
      if (/location\.href|<script/i.test(raw) && raw.length < 2000) {
        const setCookie = resp.headers.get('set-cookie');
        if (setCookie) {
          const cookie = setCookie.split(';').map((c) => c.trim().split('=')[0] + '=' + (c.trim().split('=')[1] || '')).join('; ');
          const retry = await post(cookie);
          // 重试后若仍为挑战页但拿到新 cookie（滑块/多次挑战），再试一次
          const retryRaw = await retry.text();
          if (/location\.href|<script/i.test(retryRaw) && retryRaw.length < 2000) {
            const c2 = retry.headers.get('set-cookie');
            if (c2) {
              const cookie2 = c2.split(';').map((c) => c.trim().split('=')[0] + '=' + (c.trim().split('=')[1] || '')).join('; ');
              const retry2 = await post(cookie2);
              resp = retry2; raw = await retry2.text();
            } else { resp = retry; raw = retryRaw; }
          } else { resp = retry; raw = retryRaw; }
        }
      }
      try {
        data = JSON.parse(raw);
      } catch {
        // 网关返回的不是 JSON（如 CDN 的 "error code: 1016"、HTML 错误页等）
        const snippet = String(raw).replace(/\s+/g, ' ').trim().slice(0, 160);
        const waf = /location\.href|<script|challenge|验证/i.test(snippet);
        const dnsFail = /error code|origin dns|not found|bad gateway|nginx|cloudflare|1016/i.test(snippet);
        throw new Error(
          waf
            ? `支付网关 WAF 拦截了服务器出口 IP（HTTP ${resp.status}），需联系平台加白或换网关：${snippet}`
            : dnsFail
              ? `支付网关不可达，请检查 EPAY_API_URL 是否正确/域名是否有效（HTTP ${resp.status}）：${snippet}`
              : `支付网关未返回有效 JSON（HTTP ${resp.status}）：${snippet}`
        );
      }
    } catch (e) {
      throw new Error(`易支付网关请求失败：${e.message || e}`);
    }
    if (String(data.code) !== '1') {
      throw new Error(`易支付下单失败(code=${data.code ?? '?'}): ${data.msg || '未知错误'}`);
    }
    // 官方文档：payurl / qrcode / urlscheme 三选一。优先 payurl 供浏览器跳转。
    const payUrl = data.payurl || '';
    if (!payUrl) {
      if (data.qrcode) throw new Error(`该支付方式仅返回二维码(qrcode)，请改用 alipay/wxpay 的 payurl 模式`);
      throw new Error('易支付下单成功但未返回 payurl/qrcode/urlscheme');
    }
    return { payUrl, mode: 'mapi', raw: data };
  }

  // ---- 模式 B：submit.php 拼接 GET 跳转（旧版兼容）----
  const query = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return { payUrl: `${apiUrl}?${query}`, mode: 'submit', raw: null };
}

export async function verifyNotify(params, env, config) {
  const key = config.key || env.EPAY_KEY;
  const sign = params.sign;
  if (!key) return { ok: false, reason: 'no_key' };
  const expected = buildSign(params, key);
  if (!sign || sign.toLowerCase() !== expected.toLowerCase()) {
    return { ok: false, reason: 'sign_mismatch' };
  }
  const tradeStatus = (params.trade_status || '').toUpperCase();
  if (tradeStatus && tradeStatus !== 'TRADE_SUCCESS') {
    return { ok: false, reason: 'trade_status=' + tradeStatus };
  }
  const orderNo = params.out_trade_no || params.param || '';
  const amountYuan = parseFloat(params.money || '0');
  return {
    ok: true,
    orderNo,
    tradeNo: params.trade_no || '',
    amount: Math.round(amountYuan * 100),
    raw: params,
  };
}

export { buildSign, mapPayType };
