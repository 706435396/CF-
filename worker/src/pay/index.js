/**
 * 支付通道注册表（可插拔）
 * 新增通道：实现 { createPayment, verifyNotify } 两个方法，在 ADAPTERS 注册即可。
 */
import * as epay from './epay.js';

const ADAPTERS = {
  epay: epay,
  // 预留示例（取消注释并实现即可扩展）：
  // paypal: paypal,
  // creem: creem,
  // xunhu: xunhu,
};

export function getAdapter(channel) {
  const adapter = ADAPTERS[channel] || ADAPTERS.epay;
  if (!adapter.createPayment || !adapter.verifyNotify) {
    throw new Error(`支付通道 ${channel} 未正确实现 createPayment / verifyNotify`);
  }
  return adapter;
}

export function listChannels() {
  return Object.keys(ADAPTERS);
}
