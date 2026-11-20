# VAULT 密匣 · 私密内容自动解锁系统（GitHub + Cloudflare Pages + Workers）

一套零服务器成本的**私密内容**自助解锁/自动发货系统。前台以「档案编号」形式封存内容，访客在付款前只能看到编号、分类与价格；付款验证通过后，系统自动揭示内容详情，并通过**网盘直链 / 在线阅读 / 邮件**三种方式发货。

## 隐私设计（核心）

| 阶段 | 访客能看到 | 接口保障 |
|---|---|---|
| 浏览档案馆 | 档案编号（如 NO.00001）、分类、价格、已解锁数 | `/api/products` 白名单字段，**不含**书名/作者/简介/封面/文件名/格式/链接/正文 |
| 查看详情 | 同上，无任何内容身份信息 | `/api/products/:code` 按编号查询，同样脱敏；下单用 `code` 而非 slug |
| 搜索 | 仅按档案编号数字精确匹配 | 不提供按书名/作者搜索，杜绝探测 |
| 支付收银台 | 中性的 `私密档案 NO.xxxxx` | 支付平台也不显示真实内容名 |
| 付款后查单 | 真实标题、下载链接、专属阅读链接 | `/api/orders/:no` 仅在 `status=paid` 时才揭示 |
| 在线阅读 | 正文 | `/api/read/:token` 需一单一码的专属令牌 |

> 所有真实内容字段（title/author/content/drive_url/r2_key 等）只存在于 D1 数据库，且仅在管理员登录后的后台接口或付款验证通过后才返回。**slug 由文件名生成、可能含书名，因此从不出现在任何公开接口或前端页面。**

## 架构

```
用户浏览器 ──> Cloudflare Pages（前端静态站：档案馆/解锁/查单/阅读/后台）
                     │  API 请求
                     ▼
              Cloudflare Worker（后端 API · 公开接口全部脱敏）
               ├─ D1 数据库（商品/订单/发货记录/卡密）
               ├─ R2 对象存储（内容文件，可选）
               ├─ KV（缓存/会话，可选）
               ├─ 易支付 V1（支付，可插拔多通道）
               └─ Resend（邮件发货，可选）
支付成功 ──> 易支付回调 notify_url ──> Worker 验签 ──> 标记已支付 ──> 揭示内容并自动发货
```

## 目录结构

```
CR自动发货/
├─ db/schema.sql              D1 表结构
├─ worker/                    后端 Worker（ Wrangler 部署）
│  ├─ wrangler.toml
│  └─ src/
│     ├─ index.js             入口与全部路由
│     ├─ pay/epay.js          易支付适配器（签名/验签，可插拔）
│     ├─ pay/index.js         支付通道注册表
│     └─ delivery/index.js    发货编排（link/read/email）
├─ frontend/                  Pages 前端静态站
│  ├─ index.html / book.html / order.html / read.html / admin.html
│  └─ assets/
└─ scripts/bulk_import.py     批量入库脚本
```

---

## 一、准备 Cloudflare 资源

在 [Cloudflare Dashboard](https://dash.cloudflare.com) 完成：

1. **创建 D1 数据库**：`Workers 和 Pages → D1 → 创建数据库`，名称 `novel-shop-db`，记下 Database ID。
2. **创建 KV 命名空间**（可选）：`Workers 和 Pages → KV → 创建命名空间`，记下 ID。
3. **创建 R2 存储桶**（可选）：`R2 → 创建存储桶`，名称 `novel-files`。
4. 安装 Wrangler：`npm install -g wrangler` 并 `npx wrangler login`。

## 二、部署后端 Worker

```bash
cd worker
# 1. 编辑 wrangler.toml，填入 D1 database_id 和 KV id

# 2. 建表（本地）
npx wrangler d1 execute novel-shop-db --local --file=../db/schema.sql
# 3. 建表（线上）
npx wrangler d1 execute novel-shop-db --remote --file=../db/schema.sql

# 4. 设置敏感密钥（逐个执行，按提示输入）
npx wrangler secret put EPAY_PID          # 易支付商户 PID
npx wrangler secret put EPAY_KEY          # 易支付商户密钥
npx wrangler secret put EPAY_API_URL      # 支付网关，如 https://ezfpy.cn/api.php
npx wrangler secret put ADMIN_PASSWORD    # 后台管理密码
npx wrangler secret put RESEND_API_KEY    # 邮件发货（可选，不配则跳过邮件）
npx wrangler secret put MAIL_FROM         # 发件人（Resend 需已验证域名，可选）

# 5. 部署
npx wrangler deploy
```
部署完成后记录 Worker 域名，如 `https://novel-shop-api.<你的账号>.workers.dev`。

## 三、部署前端 Pages（对接 GitHub）

1. 把整个项目 push 到 GitHub 仓库。
2. Cloudflare Dashboard → `Workers 和 Pages → Pages → 创建 → 连接到 Git`。
3. 选择仓库，构建配置：
   - **构建命令**：留空（纯静态）
   - **构建输出目录**：`frontend`
   - **根目录**：留空
4. 部署前，编辑 `frontend/assets/config.js`，把 `window.API_BASE` 改成第二步的 Worker 域名（前后端同域时才留空）。
5. 回到 Worker：在 `wrangler.toml` 设置 `FRONTEND_URL` 为前端域名，重新 `npx wrangler deploy`（让支付后跳回前端）。
6. 保存并部署。得到前端域名，如 `https://novel-shop.pages.dev`。

> 也可以在 Pages 项目 `设置 → 自定义域` 绑定你自己的域名。

## 四、配置易支付回调

登录易支付商户后台，把回调地址设为（替换成你的 Worker 域名）：
```
异步通知 notify_url：https://novel-shop-api.<账号>.workers.dev/api/pay/notify
同步跳转 return_url：https://novel-shop-api.<账号>.workers.dev/api/pay/return
```
签名方式选 **MD5**，与 `wrangler.toml` 的 `PAY_CHANNEL = "epay"` 对应。

> 同步跳转（return_url）走 Worker 的 `/api/pay/return`，为避免支付后停留在 Worker 域名，请在 `wrangler.toml` 的 `FRONTEND_URL` 填入前端 Pages 域名（如 `https://novel-shop.pages.dev`），用户付款后会自动跳回前端订单页。

## 五、添加小说

**方式 A：后台逐个添加** — 打开 `https://你的前端域名/admin.html`，输入 `ADMIN_PASSWORD`，在“添加商品”里填写。

**方式 B：批量导入** — 把 txt/epub/md 放进一个文件夹，执行：
```bash
cd scripts
python bulk_import.py --api https://novel-shop-api.<账号>.workers.dev \
  --password 你的后台密码 --dir ./我的小说 --price 9.9 --category 都市 \
  --drive-prefix https://pan.quark.cn/s   # 可选：网盘分享前缀
```
> 短篇可把正文写进数据库实现“在线阅读”；长篇建议用网盘链接发货，正文留空即可。
> 读取 epub 正文需 `pip install ebooklib`。

## 六、支付与发货流程说明

1. 用户选书 → 下单 → Worker 创建 `pending` 订单 → 易支付签名跳转。
2. 用户付款 → 易支付回调 `/api/pay/notify` → Worker 用 MD5 **验签 + 金额校验**（防伪造）。
3. 验签通过 → 订单置 `paid` → 触发发货：
   - **link**：返回网盘链接 / R2 直链；
   - **read**：生成专属令牌，用户凭 `/read.html?token=xxx` 阅读；
   - **email**：通过 Resend 发送包含上述链接的邮件。
4. 回调幂等（重复通知不重复发货），并在 `deliveries` 表留档，后台可一键**补发**。

## 七、可插拔支付通道

`worker/src/pay/index.js` 的 `ADAPTERS` 注册表即为扩展点。新增通道只需实现一个含两个方法的模块并注册：

```js
export async function createPayment(order, env, config) { /* 返回 { payUrl } */ }
export async function verifyNotify(params, env, config) { /* 返回 { ok, orderNo, amount, tradeNo } */ }
```
然后设置 `wrangler.toml` 的 `PAY_CHANNEL` 为新通道名。已预留 `paypal / creem / xunhu` 位置。

## 八、安全与注意事项

- **密钥全部用 `wrangler secret`**，绝不写进前端或提交到 GitHub。
- 易支付回调**必须验签 + 校验金额**，否则可被伪造付款。
- 在线阅读令牌绑定已支付订单，泄露即失效可后台重置；正文敏感内容建议用网盘链接模式。
- R2 文件会生成公开下载直链，请勿放不该公开的内容；需要更强保护可改为签名 URL。
- 后台默认入口 `/admin.html`，务必修改 `ADMIN_PASSWORD`。

## 九、常见问题

- **回调失败/订单一直 pending**：检查 `EPAY_API_URL`、密钥、notify_url 是否公网可达，看 Worker 日志 `npx wrangler tail`。
- **前端请求 404/CORS**：确认 `config.js` 的 `API_BASE` 指向正确 Worker 域名。
- **中文商品名验签失败**：易支付部分网关对中文参数编码敏感，可暂时用英文商品名或联系网关确认编码方式。
- **邮件没收到**：确认 `RESEND_API_KEY` 已设、`MAIL_FROM` 域名已在 Resend 验证；未配置邮件则自动跳过。
