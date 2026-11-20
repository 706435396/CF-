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
│  ├─ wrangler.toml             D1 + R2（已启用，桶 cr-commodity）绑定
│  └─ src/
│     ├─ index.js             入口与全部路由（含上传接口、令牌鉴权下载）
│     ├─ pay/epay.js          易支付适配器（签名/验签，可插拔）
│     ├─ pay/index.js         支付通道注册表
│     └─ delivery/index.js    发货编排（link/read/email）
├─ frontend/                  Pages 前端静态站
│  ├─ index.html / book.html / order.html / read.html / admin.html
│  └─ assets/
├─ scripts/bulk_import.py        批量入库脚本（正文进 D1）
└─ scripts/bulk_upload_r2.py     批量上传 R2 + 自动建商品脚本
```

---

## 一、准备 Cloudflare 资源

在 [Cloudflare Dashboard](https://dash.cloudflare.com) 完成：

1. **创建 D1 数据库**（必做）：`Workers 和 Pages → D1 → 创建数据库`，名称 `novel-shop-db`，记下 **Database ID**。
2. **创建 API Token**（必做）：`我的个人资料 → API 令牌 → 创建令牌`，选模板 **编辑 Cloudflare Workers**，权限需含 `D1:编辑`、`Workers 脚本:编辑`、`Account Settings:读取`。记下 Token 与 **Account ID**（右侧栏可见）。
3. **R2 存储桶**（可选）：仅当小说正文/文件要存进 R2 时创建；用网盘直链发货可跳过。

> KV 当前代码未使用，无需创建。

## 二、部署（前端 Pages 走 CF 原生 Git 集成 + Actions 只部署 Worker）

### 架构分工（重要）

本项目有**两套独立部署**，互不干扰：

| 部分 | 部署方式 | 触发 | 为什么 |
|---|---|---|---|
| **前端 Pages** | Cloudflare 原生 Git 集成 | push 到 `main` 自动部署 | 纯静态站，CF 原生集成最简单稳定 |
| **后端 Worker** | GitHub Actions（`.github/workflows/deploy.yml`） | push 到 `main` 自动部署 | 需要写 D1 表 + secrets，Pages 原生集成做不到 |

> 曾尝试让 Actions 同时部署 Pages，但易与 CF 原生 Git 集成**重复部署、互相覆盖**。现已收敛：Actions 只管 Worker，前端完全交给 CF 原生集成。

域名已**写死在代码里，无需再配任何 Variables**：
- 前端 API 地址：写死在 `frontend/assets/config.js` 的 `window.API_BASE`。
- 支付后回跳地址：写死在 `worker/wrangler.toml` 的 `FRONTEND_URL`。

若以后换域名，改这两个文件 → commit → push，前端 Pages 会自动重新部署，Actions 会重新部署 Worker。

### 第 1 步：配置 Cloudflare Pages 原生 Git 集成（前端）

1. Dashboard → `Workers 和 Pages → Pages → 创建 → 连接到 Git`，选择 GitHub 仓库 `CF-`。
2. 构建配置：
   - **构建命令**：留空（纯静态）
   - **构建输出目录**：`frontend` ⚠️（关键，填错会导致根域名 404）
   - **根目录 / root directory**：留空
3. 保存部署。CF 会分配形如 `https://<项目名>.pages.dev` 的域名。
   - 注意：你的仓库名 `CF-` 以连字符结尾，CF 会规范化为带后缀的名字（如 `cf-3i9`，**字母 i 不是数字 1**）。以 Dashboard 显示为准。
4. 确认生产域名可访问：项目 `部署（Deployments）` 列表中，最新一次部署的 **Production** 分支（通常是 `main`）对应的 `xxx.pages.dev` 才能打开。若只有 Preview 地址能开、根域名 404，去项目 `设置 → 构建配置 → 生产分支` 设为 `main` 并重新部署。

### 第 2 步：配置 Repository Secrets（后端 Worker Actions）

进入仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 值 | 必填 |
|---|---|---|
| `CF_API_TOKEN` | 第一节创建的 API Token | ✅ |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID | ✅ |
| `D1_DATABASE_ID` | D1 数据库的 Database ID | ✅ |
| `EPAY_PID` | 易支付商户 PID | 可选* |
| `EPAY_KEY` | 易支付商户密钥 | 可选* |
| `EPAY_API_URL` | 支付网关，如 `https://ezfpy.cn/api.php` | 可选* |
| `ADMIN_PASSWORD` | 后台管理密码 | 可选* |
| `RESEND_API_KEY` | 邮件发货（不配则跳过邮件） | 可选 |
| `MAIL_FROM` | 发件人（Resend 需验证域名） | 可选 |

> \* 支付/后台密钥也可在本地用 `wrangler secret put` 设置一次（会持久保留），不一定放 GitHub；要走 CI 自动写入就填这里。

**Variables 无需再配置**（`WORKER_URL` / `FRONTEND_URL` / `PAGES_PROJECT` 均已废弃，可删除）。

### 第 3 步：触发部署与验收

1. 任意改动 push 到 `main`，CF Pages（前端）与 Actions（Worker）会**各自自动部署**。
2. Actions 先检查凭证：3 个必填 Secret 缺任一个 → 本次**跳过**（绿勾 + Summary 列出缺项），不会失败。
3. 凭证齐全 → 自动建表（幂等）→ 写 secrets → 部署 Worker。Actions 运行页 **Summary** 会显示 Worker 地址。
4. 验收：
   - 打开前端 Pages 域名 → 首页能加载出档案卡（说明前端 → Worker API 通了）。
   - 打开 `/admin.html`，输入 `ADMIN_PASSWORD` 能登录（说明 Worker secret 写入成功）。
   - 若首页白屏 → 多半是 `config.js` 的 `API_BASE` 与 Worker 实际域名不符，核对后改之。

## 三、手动部署（备选 · 不依赖 GitHub Actions）

本地命令行部署：

```bash
npm install -g wrangler && npx wrangler login
cd worker
# 1. 编辑 wrangler.toml，填入 D1 database_id（FRONTEND_URL 已写死，一般无需改）
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
```
Worker 域名形如 `https://novel-shop-api.<账号>.workers.dev`。前端 Pages 推荐走第二节的原生 Git 集成（push 自动部署，输出目录 `frontend`）；若临时手动上传，可执行 `cd frontend && npx wrangler pages deploy . --project-name=<你的项目名>`（确保 `config.js` 的 `API_BASE` 已指向上面的 Worker 域名）。

## 四、配置易支付（V1 · mapi.php）

### 1. 商户后台设置
- **签名方式**：选 **MD5**（即兼容模式 / V1 MD5，不要选「仅 RSA」）。
- **接口地址（API 提交地址）**：填 V1 的 `mapi.php` 完整地址，如 `https://epay.weixii.com/mapi.php` —— 这是服务端 POST 调用、返回 JSON 的接口。
  - 旧地址 `epay.weixlf.com` 域名已失效（2026-11 起公网 DNS 无解析，返回 1016），已迁移至 `epay.weixii.com`。
  - 代码会自动识别：URL 含 `mapi.php` → 走 POST+JSON 模式；否则按旧版 `submit.php` 的 GET 跳转处理。**推荐用 mapi.php**。
- 回调地址无需在后台手填：下单时代码会自动把 `notify_url` / `return_url` 传给平台。它们指向：
  ```
  异步通知 notify_url：https://novel-shop-api.<账号>.workers.dev/api/pay/notify
  同步跳转 return_url：https://novel-shop-api.<账号>.workers.dev/api/pay/return
  ```

### 2. GitHub Secrets（三必填之外，支付相关）
| Secret | 值 | 说明 |
|---|---|---|
| `EPAY_PID` | 商户 ID（如 `86957`） | 后台「商户ID」 |
| `EPAY_KEY` | V1 的 MD5 密钥（32 位） | 后台「MD5密钥」，**不是 RSA 密钥** |
| `EPAY_API_URL` | `https://epay.weixii.com/mapi.php` | V1 接口地址，以平台后台「URL地址」为准（旧 weixlf.com 已失效） |

### 3. 协议适配说明（代码已实现，符合 V1 官方文档）
- 提交参数含官方必填的 `pid` / `type` / `out_trade_no` / `notify_url` / `name` / `money` / `clientip` / `sign` / `sign_type`。
- **支付方式映射**：前端「微信支付→`wxpay`」「QQ钱包→`qqpay`」「支付宝→`alipay`」，与官方 `type` 取值一致。
- 签名：参数按名升序、排除 `sign`/`sign_type`/空值，拼 `k=v&k=v` 后接商户密钥做 MD5（小写），与官方 MD5 算法逐条对应。
- 回调验签：校验 sign + 仅认 `trade_status=TRADE_SUCCESS` + 金额校验 + 幂等（重复通知不重复发货）。
- 下单取平台返回 JSON 的 `payurl` 供浏览器跳转（若某支付方式只返回 `qrcode`，需在后台改用能返回 payurl 的通道）。

> 同步跳转（return_url）走 Worker 的 `/api/pay/return`，付款后自动跳回前端订单页——前提是 `wrangler.toml` 的 `FRONTEND_URL` 已填前端 Pages 域名（当前已写死为 `https://cf-3i9.pages.dev`，如需改域名直接改该文件）。

## 五、添加小说

**方式 A：后台逐个添加** — 打开 `https://你的前端域名/admin.html`，输入 `ADMIN_PASSWORD`，在“添加商品”里填写。

**后台批量改价** — `admin.html`「商品管理」页顶部有「批量改价」工具栏。勾选商品（或全选）后选方式：
- **设为固定价**：统一改成某价格（元）；
- **加价/降价**：每件增减某金额（元，负数即降价，最低 0）；
- **按倍率**：如 `0.9` 打九折、`1.1` 涨一成。

作用范围可选「应用到选中 / 应用该分类 / 应用全部」。后端 `PUT /api/admin/batch-price` 一次请求用 D1 batch 批量更新，改完自动刷新列表；执行前有确认弹窗，操作不可撤销。

**方式 B：批量导入** — 把 txt/epub/md 放进一个文件夹，执行：
```bash
cd scripts
python bulk_import.py --api https://novel-shop-api.<账号>.workers.dev \
  --password 你的后台密码 --dir ./我的小说 --price 9.9 --category 都市 \
  --drive-prefix https://pan.quark.cn/s   # 可选：网盘分享前缀
```
> 短篇可把正文写进数据库实现“在线阅读”；长篇建议用网盘链接发货，正文留空即可。
> 读取 epub 正文需 `pip install ebooklib`。

### 方式 C：后台网页上传文件到 R2（推荐，含鉴权）

R2 桶 `cr-commodity` 已通过 `wrangler.toml` 的 `[[r2_buckets]]` 绑定为 `FILES`。在 `admin.html` 的“添加商品”里可直接选文件上传：

选好文件（**可按 Ctrl/Shift 多选**，txt/md/epub/pdf，单个≤100MB）后有两个按钮：

- **仅传 R2**：只把选中的文件逐个上传到 R2，拿到随机 key（形如 `files/a1b2c3....txt`，不可猜、不含中文）。单个 key 自动填入「R2 文件 key」；多个在消息区列出每个文件→key 的对照表，你再自己逐个建商品、填对应 key。
- **一键批量上架**：传 R2 **并自动为每个文件建一个商品**——书名取文件名（去扩展名），价格/划线价/分类/作者/状态用上方表单的填写值，格式按扩展名，slug 自动生成并去重。几百本也能一次上架完。

- **文件夹批量上架**（大批量首选）：在“添加商品”面板底部「文件夹批量上架」区，点「选择文件夹」选整个目录（含子目录自动递归），设并发数（1~8，默认4）后点「开始批量上架」。特性：
  - **并发上传**：多个文件并行传 R2 + 建商品，比逐个快数倍；
  - **断点续传**：按「相对路径+大小+修改时间」指纹把成功记录存本机 localStorage，中途关页面/失败后重选同一文件夹继续，已成功的自动跳过（清除记录在「清除断点记录」按钮）；
  - **失败重试**：单个文件失败自动重试 3 次，不影响其他文件；
  - **实时进度**：进度条 + 逐条日志（成功 key / 失败原因）。
  - 注意：断点记录存当前浏览器，换浏览器或清缓存会丢失；书名取文件名（含子目录时取最末段），价格/分类/作者/状态仍用上方表单值。

买家付款后即拿到带令牌的下载链接。

底层是 `POST /api/admin/upload`（后台登录 token 鉴权），用随机串生成 key 写入 R2。也可用命令行直传：
```bash
npx wrangler r2 object put cr-commodity/files/自定义.txt --file=./本地.txt
```

**下载鉴权（重要）**：`/api/file/:key` 不再公开。下载链接形如 `/api/file/files/xxx.txt?token=<32位令牌>`，令牌在**付款时一单一码生成**，且服务端校验「令牌属于已支付订单 + 该订单商品确实绑定这个 key」，双重防越权。无令牌/未支付/文件不匹配一律 403。因此：
- 桶**不要**开启 `r2.dev` 公有域名，所有访问走 Worker 鉴权接口；
- 别把带 token 的链接到处转发（等同一次性凭证，虽未设过期但绑定订单）。

### 方式 D：批量上传文件到 R2 + 自动建商品（大批量推荐）

文件多（几十~上千本）时用脚本，扫文件夹 → 逐个传 R2 → 自动建商品绑定 key，一步到位：
```bash
cd scripts
python bulk_upload_r2.py --api https://novel-shop-api.<账号>.workers.dev \
  --password 你的后台密码 --dir ./我的小说 \
  --price 9.9 --category 都市 --author 佚名
```
- 支持 txt/md/epub/pdf，递归子文件夹；随机 key（不可猜、无中文）；书名取文件名、价格自动转分、正文留空靠带令牌链接发货（txt/md 可在线阅读）。
- `--dry-run` 先看将处理哪些文件、`--limit 5` 先小批试跑、`--delay 0.3` 控制间隔、`--status off` 建为下架待检查。
- slug 自动去重（重名加 `-2`），已存在的商品会跳过重名，便于中断后续跑。
- 与方式 B 区别：B 把正文读进 D1 数据库，D 把文件存 R2（适合大文件/任意格式）。

**几种导入方式对比**：

| 方式 | 批量 | 并发/断点 | 正文/文件存哪 | 适用场景 |
|---|---|---|---|---|
| A 后台逐个 | ❌ | — | D1 正文 或 R2 | 临时加一两本 |
| B `bulk_import.py` | ✅ 文件 | ❌ | D1 正文 / 网盘链接 | 短篇、要在线阅读 |
| C 网页「一键批量上架」 | ✅ 文件 | 串行，无断点 | R2 | 选多文件、可视化上架 |
| C+ 网页「文件夹批量上架」 | ✅ 整个文件夹递归 | ✅ 并发+断点续传+重试 | R2 | 网页端大批量首选，几千本 |
| D `bulk_upload_r2.py` | ✅ 整个文件夹递归 | 串行，命令行可续跑 | R2 | 超大批量、无人值守脚本 |

> 网页端做不到「定时/监听文件夹全自动」——关掉浏览器就停。若要真正无人值守（往文件夹丢文件就自动上架），用方式 D 配合系统定时任务（Windows 任务计划程序）常驻运行。

**存储压缩说明**：正文（`content` 字段）当前为明文存储，HTTP 传输由 Cloudflare 自动 gzip/Brotli 压缩；数据库内的存储压缩（如 gzip 后 base64）尚未实现。大文件建议走 R2/网盘而非塞进 `content`。

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
