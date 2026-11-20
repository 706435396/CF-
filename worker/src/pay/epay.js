/**
 * 易支付 V1 适配器
 * 协议：彩虹易支付 / 码支付同类通用接口
 * 下单：GET {api_url}?...params&sign=xxx&sign_type=MD5
 * 回调：notify_url 收到 POST/GET 参数，需用同样算法验签
 *
 * 对外实现两个方法（供 index.js 调用）：
 *   createPayment(order, env, config) -> { payUrl }
 *   verifyNotify(params, env, config) -> { ok, tradeNo, amount, orderNo, raw }
 */
import { md5 } from './md5.js';

function buildSign(params, key) {
  // 易支付签名规则：
  // 1) 过滤 sign/sign_type/空值
  // 2) 按参数名 ASCII 升序排列
  // 3) 拼成 k=v&k=v
  // 4) 末尾拼接商户密钥 key（官方 V1：MD5(拼接串 + key)）
  const keys = Object.keys(params)
    .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '' && params[k] !== undefined && params[k] !== null)
    .sort();
  const str = keys.map((k) => `${k}=${params[k]}`).join('&') + key;
  return md5(str);
}

export async function createPayment(order, env, config) {
  const pid = config.pid || env.EPAY_PID;
  const key = config.key || env.EPAY_KEY;
  const apiUrl = config.apiUrl || env.EPAY_API_URL;
  if (!pid || !key || !apiUrl) throw new Error('易支付配置缺失：请设置 EPAY_PID / EPAY_KEY / EPAY_API_URL');

  const origin = (config.notifyBase || '').replace(/\/$/, '');
  const params = {
    pid,
    money: (order.amount / 100).toFixed(2), // 易支付金额单位为元
    name: order.product_title || '数字内容',
    notify_url: `${origin}/api/pay/notify`,
    return_url: `${origin}/api/pay/return?order_no=${order.order_no}`,
    out_trade_no: order.order_no,
    param: order.order_no,
    sign_type: 'MD5',
  };
  params.sign = buildSign(params, key);
  const query = Object.keys(params)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  return { payUrl: `${apiUrl}?${query}` };
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

// 导出便于单元自测
export { buildSign };
