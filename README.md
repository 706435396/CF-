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

1. **创建 D1 数据库**（必做）：`Workers 和 Pages → D1 → 创建数据库`，名称 `novel-shop-db`，记下 **Database ID**。
2. **创建 API Token**（必做）：`我的个人资料 → API 令牌 → 创建令牌`，选模板 **编辑 Cloudflare Workers**，权限需含 `D1:编辑`、`Workers 脚本:编辑`、`Account Settings:读取`。记下 Token 与 **Account ID**（右侧栏可见）。
3. **R2 存储桶**（可选）：仅当小说正文/文件要存进 R2 时创建；用网盘直链发货可跳过。

> KV 当前代码未使用，无需创建。

## 二、自动部署（推荐 · 已内置 GitHub Actions）

仓库已内置 `.github/workflows/deploy.yml`。配好下方 Secrets / Variables 后，**每次 push 到 `main`（或手动点 Run workflow）自动完成：建表 → 写密钥 → 部署 Worker → 部署 Pages**，本地无需装 wrangler。

### 第 1 步：配置 Repository Secrets

进入仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 值 | 必填 |
|---|---|---|
| `CF_API_TOKEN` | 上一步创建的 API Token | ✅ |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID | ✅ |
| `D1_DATABASE_ID` | D1 数据库的 Database ID | ✅ |
| `EPAY_PID` | 易支付商户 PID | 可选* |
| `EPAY_KEY` | 易支付商户密钥 | 可选* |
| `EPAY_API_URL` | 支付网关，如 `https://ezfpy.cn/api.php` | 可选* |
| `ADMIN_PASSWORD` | 后台管理密码 | 可选* |
| `RESEND_API_KEY` | 邮件发货（不配则跳过邮件） | 可选 |
| `MAIL_FROM` | 发件人（Resend 需验证域名） | 可选 |

> \* 支付/后台密钥也可在本地用 `wrangler secret put` 设置一次（会持久保留），不一定放 GitHub；要走 CI 自动写入就填这里。

### 第 2 步：配置 Repository Variables

同页面切到 `Variables` 标签：

| Variable | 值 | 说明 |
|---|---|---|
| `WORKER_URL` | `https://novel-shop-api.<账号>.workers.dev` | 注入前端 `config.js` 的 `API_BASE`；首次可留空 |
| `FRONTEND_URL` | `https://vault-shop.pages.dev` | 支付后跳回前端用；首次可留空 |
| `PAGES_PROJECT` | `vault-shop` | Pages 项目名，留空则默认 `vault-shop` |

### 第 3 步：触发部署

1. 任意改动 push 到 `main`，或在 Actions 页点 `Run workflow`。
2. 工作流先检查凭证：3 个必填 Secret 缺任一个 → 本次**跳过**（绿勾 + Summary 列出缺项），不会失败。
3. 凭证齐全 → 自动建表（幂等）→ 写 secrets → 部署 Worker → 部署 Pages。
4. 到 Actions 运行页 **Summary** 查看 Worker / Pages 地址。

### 第 4 步：回填域名（首次部署后做一次）

1. 拿到 Worker 域名 → 填入 Variable `WORKER_URL`。
2. 拿到 Pages 域名 → 填入 Variable `FRONTEND_URL`。
3. 再 push 一次（或点 Run workflow）——此时前端 `config.js` 带上正确 API 地址，支付后也能跳回前端。

> 自定义域名：在 Pages / Worker 项目 `设置 → 自定义域` 绑定自己的域名，再把该域名填进 `WORKER_URL` / `FRONTEND_URL`。

## 三、手动部署（备选 · 不依赖 GitHub Actions）

本地命令行部署：

```bash
npm install -g wrangler && npx wrangler login
cd worker
# 1. 编辑 wrangler.toml，填入 D1 database_id
# 2. 建表
npx wrangler d1 execute novel-shop-db --remote --file=../db/schema.sql
# 3. 设置敏感密钥（按提示输入）
npx wrangler secret put EPAY_PID
npx wrangler secret put EPAY_KEY
npx wrangler secret put EPAY_API_URL
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put RESEND_API_KEY   # 可选
npx wrangler secret put MAIL_FROM        # 可选
# 4. 部署 Worker
npx wrangler deploy
# 5. 部署 Pages（先在 frontend/assets/config.js 填 Worker 域名）
npx wrangler pages deploy ../frontend --project-name=vault-shop --commit-dirty=true
```
 Worker 域名形如 `https://novel-shop-api.<账号>.workers.dev`，Pages 域名形如 `https://vault-shop.pages.dev`。

> Pages 也可走原生 Git 集成：Dashboard → `Pages → 创建 → 连接到 Git`，构建命令留空、输出目录 `frontend`（此方式只自动部署前端，Worker 仍需手动/CI 部署）。

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
