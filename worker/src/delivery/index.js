/**
 * 发货编排：根据订单 delivery_method 组合多种发货方式
 * - link：网盘/直链（含 R2 签名直链）
 * - read：在线阅读令牌（防泄露，绑定邮箱）
 * - email：通过 Resend 发送包含上述链接的邮件
 */

// 生成一个随机令牌（32 位 hex）
export function genToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function originOf(request) {
  return new URL(request.url).origin;
}

export async function fulfillOrder(env, order, product, request) {
  const origin = originOf(request);
  const results = [];
  const method = order.delivery_method || env.DELIVERY_METHOD || 'all';
  const want = (m) => method === 'all' || method === m;

  // 1) 网盘 / 直链
  let downloadUrl = product.drive_url || '';
  if (!downloadUrl && product.r2_key && env.FILES) {
    // R2 对象：优先返回公开绑定域名，否则返回 API 下载路径
    downloadUrl = `${origin}/api/file/${encodeURIComponent(product.r2_key)}`;
  }
  if (want('link')) {
    results.push({ method: 'link', content: downloadUrl || '（未配置下载链接）' });
  }

  // 2) 在线阅读令牌
  let readToken = order.read_token;
  if (want('read') && !readToken) {
    readToken = genToken();
    await env.DB.prepare(
      'UPDATE orders SET read_token=? WHERE order_no=?'
    ).bind(readToken, order.order_no).run();
  }
  const readUrl = readToken ? `${origin}/read.html?token=${readToken}` : '';
  if (want('read')) {
    results.push({ method: 'read', target: readToken, content: readUrl });
  }

  // 3) 邮件（把 link + read 汇总发送）
  if (want('email') && order.email) {
    const text = buildMailText(product, downloadUrl, readUrl, origin, order.order_no);
    const ok = await sendEmail(env, order.email, `【发货通知】${product.title}`, text);
    results.push({ method: 'email', target: order.email, content: ok ? 'sent' : 'failed', status: ok ? 'success' : 'failed' });
  }

  // 写入发货记录
  for (const r of results) {
    try {
      await env.DB.prepare(
        'INSERT INTO deliveries (order_no, product_id, method, target, content, status, created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(order.order_no, product.id, r.method, r.target || '', r.content || '', r.status || 'success', Date.now()).run();
    } catch (e) { /* 记录失败不影响主流程 */ }
  }

  // 汇总返回给前端展示
  return {
    downloadUrl: want('link') ? downloadUrl : '',
    readUrl: want('read') ? readUrl : '',
    readToken: want('read') ? readToken : '',
    email: want('email') ? order.email : '',
    results,
  };
}

function buildMailText(product, downloadUrl, readUrl, origin, orderNo) {
  let body = `感谢购买《${product.title}》${product.author ? '（作者：' + product.author + '）' : ''}！\n\n`;
  if (downloadUrl) body += `【下载链接】\n${downloadUrl}\n\n`;
  if (readUrl) body += `【在线阅读】（专属链接，请勿转发）\n${readUrl}\n\n`;
  body += `【订单号】${orderNo}\n\n如遇问题请回复本邮件。\n`;
  return body;
}

async function sendEmail(env, to, subject, text) {
  const apiKey = env.RESEND_API_KEY;
  const from = env.MAIL_FROM || 'Novel Shop <onboarding@resend.dev>';
  if (!apiKey) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text }),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}
