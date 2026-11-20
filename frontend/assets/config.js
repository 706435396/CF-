// ============ 前端全局配置 ============
// 部署后把 API_BASE 改成你的 Worker 域名，例如 https://novel-shop-api.xxx.workers.dev
// 如果前后端同域，可留空字符串 ''
window.API_BASE = '';
window.SITE_NAME = 'VAULT 密匣 · 私密内容档案馆';

// 统一的锁形图标（列表卡片 / 详情页复用）
window.LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3" fill="currentColor" stroke="none"/></svg>';
window.LOCK_MINI = '<svg class="lock-mini" viewBox="0 0 24 24" fill="none" stroke-width="1.8"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>';

// 统一请求封装
async function api(path, options = {}) {
  const base = (window.API_BASE || '').replace(/\/$/, '');
  const resp = await fetch(base + path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  return resp.json();
}

function fmtPrice(fen) {
  return '¥' + (Number(fen) / 100).toFixed(2);
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function qs(name) {
  return new URLSearchParams(location.search).get(name) || '';
}
