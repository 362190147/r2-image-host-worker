# r2-image-host-worker

**Cloudflare Worker 版**图床：上传的图片直接进 R2，外链由 R2 自定义域名（或 Worker 自身）提供。零 npm 运行时依赖，只用 WebCrypto 与 R2 绑定。

功能：拖拽/粘贴上传、内容寻址去重、只信魔数的类型校验、可选预签名直传、`/i/` 读图兜底（ETag/Range/HEAD）、删除护栏、
`/api/diag` 配置体检、`/api/list` 历史清单（列桶）、上传后外链可达性自检。API 全部受口令保护。

> 同作者另有一个功能对齐的 **Node 版**（自己服务器上跑，服务端保存 S3 密钥代签代传），
> 不在本仓库里。两者 API 一致，可按部署环境二选一。
>
> | | Node 版 | Worker 版（本仓库） |
> | --- | --- | --- |
> | 运行位置 | 自己的 VPS/NAS/Docker | Cloudflare 全球边缘，无服务器 |
> | R2 凭据 | 服务端保存 S3 密钥，服务端代签代传 | 平时**不需要** S3 密钥，只用 R2 绑定 |
> | 图片字节 | 经你的服务器中转（占用自己带宽） | 默认经 Worker（边缘内网）；可切预签名让浏览器直传 R2 |
> | 依赖 | Node ≥ 20 | wrangler（仅部署用） |

## 两种上传模式

用 `UPLOAD_MODE` 切换，**默认 `direct`**：

### `direct`（默认，推荐）

```
浏览器 ──multipart──▶ Worker ──R2 绑定──▶ R2
```

- Worker 用 **R2 绑定**写桶，不需要把 S3 密钥给 Worker，也不存在 CORS 问题；
- 单文件上限受 Workers 请求体限制约束（见下面的「限制」）；
- 需要 R2 绑定，不需要 `R2_ACCOUNT_ID` 等 S3 凭据。

### `presign`

```
浏览器 ──① 求签名──▶ Worker
浏览器 ──② 直接 PUT 图片字节──▶ R2（不经过 Worker）
```

- Worker 只返回一个预签名 PUT URL，图片字节由浏览器直接上传到 R2：**省 Worker 请求与流量**，且不受 Workers 请求体上限约束；
- 需要给 Worker 配 S3 凭据（`wrangler secret put R2_ACCOUNT_ID` 等）用于签名；
- **必须给桶配 CORS**（见下），否则浏览器直传会被挡；
- 签名只覆盖 `host`，所以浏览器可以自由设置 `content-type` / `cache-control`；
- 去重仍会生效：Worker 先 `HEAD` 一次，对象已存在就返回 `skipUpload: true`，浏览器跳过直传。

## 部署

> 说明：下面的 wrangler 命令我没能在本项目环境里实跑（该环境没有 npm 且外网 registry 不通，装不了 wrangler），
> 所以逻辑正确性靠 `npm test` 覆盖，CLI 与构建请以你机器上的实际输出为准。首次部署建议先跑 `--dry-run`。

### 0. 前置

- Node ≥ 18（wrangler 需要），一个已开通 **R2** 的 Cloudflare 账号；
- 首次使用需在控制台 R2 页面点一下开通（要绑支付方式，免费额度内不收费）。

### 1. 装 wrangler 并登录

```bash
cd r2-image-host-worker
npm install                 # 只装 wrangler（开发依赖，不进 Worker 运行时）
npx wrangler --version
npx wrangler login          # 浏览器授权；无浏览器时改用 CLOUDFLARE_API_TOKEN 环境变量
```

令牌方式（CI 或服务器上无浏览器时）：创建一枚 **Edit Cloudflare Workers** 模板的 API Token，然后

```bash
export CLOUDFLARE_API_TOKEN=xxxxx
export CLOUDFLARE_ACCOUNT_ID=xxxxx   # 多账号时必填
```

### 2. 建桶

```bash
npx wrangler r2 bucket create images
npx wrangler r2 bucket list          # 确认存在
```

桶名想换就换成别的，但要和下一步的 `R2_BUCKET` 保持一致。

### 3. 改 `wrangler.toml`

```toml
name = "r2-image-host"        # 会变成 <name>.<你的子域>.workers.dev
[vars]
R2_BUCKET = "images"          # ← 和桶名一致
UPLOAD_MODE = "direct"        # 先用 direct，跑通再考虑 presign
R2_PUBLIC_BASE = ""           # 见第 6 步

[[r2_buckets]]
binding = "IMAGES"            # 代码里用的绑定名，别改
bucket_name = "images"        # ← 和桶名一致
```

### 4. 配口令（公网必做）

```bash
npx wrangler secret put UPLOAD_TOKEN     # 建议 openssl rand -hex 24 生成
npx wrangler secret put DELETE_TOKEN
```

> 这一步在后；**secrets 要在 deploy 前或后设置都可以**，但没设 `UPLOAD_TOKEN` 时任何人都能往你的桶里传东西。

### 5. 校验后发布

```bash
npx wrangler deploy --dry-run --outdir dist   # 先干跑：验证配置与打包，不发布
npx wrangler deploy                           # 正式发布
```

`--dry-run` 是最省事的验证手段：它会真正执行 esbuild 打包，能提前暴露 `main` 路径、绑定名写错这类问题。发布成功后会打印你的访问地址，形如 `https://r2-image-host.<子域>.workers.dev`。

> 页面模板走的是**构建期生成**的静态字符串：`public/index.html` → `npm run build:page` → `src/page.mjs`。
> `dev` / `deploy` / `dry-run` 都会自动先跑生成，正常流程不用管；只有手改了 `public/index.html` 又绕过 npm 脚本时才需要手动生成一次。
> 忘了生成的后果是页面停在旧版本，`npm test` 里的 `test/page.test.mjs` 会直接报出来。

### 6. 让图片能外链访问（关键，容易漏）

R2 桶**默认一律不公开**，必须显式开启。两种官方公开方式（外加一种不变通的办法）：

**A. 绑自定义域名（推荐，生产用）**

前置条件：该域名必须已作为 **zone 加在同一个 Cloudflare 账号**下（已由 Cloudflare 托管即可；不在 Cloudflare 的域名要先做 [partial/CNAME setup](https://developers.cloudflare.com/dns/zone-setups/partial-setup/)）。

1. 控制台进入 **R2 object storage** 页面 → 选中桶 `images`；
2. 选 **Settings** → **Custom Domains** → **Add**；
3. 填要用的域名（如 `img.example.com`）→ **Continue**；
4. 核对将写入的 DNS 记录 → **Connect Domain**；
5. 状态从 **Initializing** 变 **Active** 需要几分钟，刷新页面查看；一直不变就点域名旁的 `...` → **Retry connection**；
6. 验证：浏览器打开 `https://img.example.com/<key>` 能看到图；桶的 Settings 里 **Access to Bucket** 显示为 Allowed；
7. 把 `wrangler.toml` 里 `R2_PUBLIC_BASE = "https://img.example.com"`，重新 `npx wrangler deploy`。

好处：外链直连 R2，**不消耗 Worker 请求**；而且只有走自定义域名才有缓存、WAF、Bot Management、Access 这些能力。

> 两个注意：公开桶**不支持在域名根路径列目录**，只能按已知 key 取对象；
> Enterprise 账号如果对 zone 开了 zone hold，要先 [release zone hold](https://developers.cloudflare.com/fundamentals/account/account-security/zone-holds/#release-zone-holds)，否则子域激活不了。

**B. r2.dev 开发域名（仅测试/临时）**

1. R2 → 桶 → **Settings** → **Public Development URL** → **Enable**；
2. 弹窗里输入 `allow` 确认 → **Allow**；
3. 拿到形如 `https://pub-xxxx.r2.dev` 的地址，填进 `R2_PUBLIC_BASE` 并重新 deploy；
4. 验证：Settings 里 **Public URL Access** 显示 **Allowed**。

> 官方明确说它是 **non-production**：有速率限制，且**没有**缓存/WAF/Bot Management/Access；
> 也不要给它建 CNAME（不受支持的访问路径）。不用了就点 **Disable**（输入 `disallow` 确认）。
>
> 安全检查：如果同时用自定义域名 + Cloudflare Access/WAF 做鉴权，**必须把 r2.dev 关掉**，
> 否则桶仍然能通过 r2.dev 公开访问，鉴权形同虚设。

**C. 什么都不配（走 Worker 兜底）**

`R2_PUBLIC_BASE` 留空，外链回落成 `https://你的worker域名/i/<key>`，由 Worker 用绑定读 R2 再回传。**不需要把桶公开**，能用，但每张图都消耗一次 Worker 调用。

> 无论选哪种，`presign` 模式（浏览器直传 R2）都还需要给桶配 CORS，见第 7 步。

### `R2_PUBLIC_BASE` 到底该填什么

**一句话：填"能匿名把桶里对象读出来的那个公开域名"**，不是桶名、也不是 R2 的 S3 端点。它只是用来拼外链：最终 URL = `R2_PUBLIC_BASE + "/" + key`。

四种合法取值：

| 取值 | 说明 |
| --- | --- |
| `https://img.example.com` | **桶绑定的自定义域名**（第 6 步方式 A）——生产推荐 |
| `https://pub-xxxx.r2.dev` | 桶的 r2.dev 开发域名（方式 B）——仅测试 |
| 留空 | 外链回落成 `<部署域名>/i/<key>`，由 Worker 读 R2 回传（方式 C，不需要公开桶） |
| — | **不能**填 `https://<account>.r2.cloudflarestorage.com`，那是需签名的 S3 API 端点 |

三个必须注意的点：

1. **必须带协议头 `https://`。** 只写 `img.example.com` 不行，`//img.example.com` 这种协议相对写法也不行——两种情况都会**静默回落**到部署域名，外链变成 `https://<你的worker域名>/<key>`，你想要的"直连 R2"就落空了（`/api/diag` 的 `lint.problems` 会指出来，日志里也有 warn）。
   用 `http://` 技术上能跑，但图片会走明文、在 HTTPS 页面里可能被浏览器拦成 mixed content——**只用 `https://`**。
   末尾有没有 `/` 无所谓，会自动规范掉。
2. **它必须和 Worker 自己的域名不同。** 如果 Worker 已经占了 `img.example.com`，那桶就得绑另一个子域（如 `cdn.example.com`）——同一主机名下 Worker 会抢先应答，R2 收不到（详见下面「域名能不能和 Worker 用同一个？」）。
3. **不要写路径。** 代码只取 URL 的 origin，`https://img.example.com/i` 里的 `/i` 会被丢掉，对象按 `https://img.example.com/<key>` 访问。这种情况 `/api/diag` 的 `lint.problems` 会明确告警。
4. 桶绑的域名要和这里**完全一致**——`https://img.example.com` 和 `https://www.img.example.com` 是两个不同的域名。

实测四种写法的结果：

| 写法 | 图片 URL | 说明 |
| --- | --- | --- |
| `https://img.example.com` | `https://img.example.com/img/…png` | ✅ 正确 |
| `https://img.example.com/` | `https://img.example.com/img/…png` | ✅ 末尾斜杠被规范掉 |
| `img.example.com` | `https://<worker域名>/img/…png` | ❌ 回落到部署域名 |
| `//img.example.com` | `https://<worker域名>/img/…png` | ❌ 同上 |

一句话校验：

```bash
# 用上传返回的 key 直接试
curl -sI "https://img.example.com/img/2026/10/<hash>.png" | head -3
# HTTP/2 200 + content-type: image/png → 填对了
# 401/403 → 桶没公开，或域名没绑对
```


### 域名能不能和 Worker 用同一个？

**同一个主机名不能同时挂 Worker 和 R2。** 路由优先级是 **Worker routes / Worker Custom Domains > R2 custom domain**：请求先进 Worker，R2 根本收不到。更坑的是控制台**不会警告**，R2 面板照样把域名显示成 Active，两端各自都"健康"。

典型翻车：账号里早先给别的站点配了通配路由 `*.example.com/*`，然后给桶绑 `media.example.com` —— 所有图片请求都被通配 Worker 吃掉，返回的是那个站点的 HTML 404 页。

**判断方法（30 秒）**：

```bash
curl -sI https://media.example.com/你的key.png | grep -i content-type
# 图片却返回 text/html —— 说明不是 R2 在应答，有 Worker 抢先了
```

然后去 **Workers & Pages → 你的 Worker → Settings → Domains & Routes** 看路由模式，凡是覆盖该子域的通配就是元凶（更具体的路由优先于通配，但别依赖"排除法"，实测过再信）。

**所以本项目的推荐姿势是：**

- **首选：只用一个域名。** Worker 绑 `img.example.com`，`R2_PUBLIC_BASE` 留空，图片走同一个域名的 `/i/<key>`（Worker 用绑定读 R2）。一个域名、一套证书、不需要公开桶、不消耗额外 Worker 额度之外的资源 —— 代价是每张图过一次 Worker。
- **要直连 R2 就换个子域名**：Worker 用 `img.example.com`，桶绑 `cdn.example.com`，`R2_PUBLIC_BASE = "https://cdn.example.com"`。子域不同就不冲突。
- 临时用 r2.dev 顶着也行：Worker 保持自定义域名，桶的公开访问走 r2.dev。

### 7. （可选）切 presign 模式

```bash
# R2 → API → Manage API tokens → 建一枚限定到 images 桶的 Object Read & Write 令牌
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
# 再把 wrangler.toml 的 UPLOAD_MODE 改成 "presign" 并重新 deploy
npx wrangler deploy
```

然后给桶配 CORS（不配的话浏览器直传会报 CORS 错）——控制台 → R2 → 桶 → Settings → CORS Policy：

```json
[
  {
    "AllowedOrigins": ["https://r2-image-host.你的子域.workers.dev", "https://img.example.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type", "cache-control"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

### 8. 部署后自检

```bash
BASE=https://r2-image-host.你的子域.workers.dev
TOKEN=你设置的 UPLOAD_TOKEN

# 1) 页面能打开、配置读得到
curl -s $BASE/api/config

# 2) 带口令看详细配置（应能看到 bucket / mode / limit）
curl -s -H "x-upload-token: $TOKEN" $BASE/api/health

# 3) 传一张图，直接拿到直链
curl -sL -F "file=@test.png" -H "x-upload-token: $TOKEN" "$BASE/api/upload?redirect=1"
# 打印出来的 URL 用浏览器打开应能看到图（打不开就回第 6 步）
```

### 本地开发

```bash
npm run dev            # wrangler dev：本地跑 Worker，R2 绑定默认是本地模拟桶
npm run dev -- --remote  # 直接读写线上真桶（调试用）
```

本地模拟桶里的对象和线上是两套数据，别被"本地传成功了、线上看不到"绕进去。

## 已修复：页面报 Error 1101

**症状**：部署成功，但访问 `/` 得到 `Error 1101 · Worker threw exception`，每次请求都复现。

**根因**：早期版本用 `await import('../public/index.html')` 加载页面模板，靠 `wrangler.toml` 的 `[[rules]] type = "Text"` 把它变成字符串。但 esbuild 的 Text 产物是**裸 HTML 文本文件**（`dist/<hash>-index.html` 的首行就是 `<!doctype html>`），并不是 JS 模块。workerd 在**模块实例化阶段**就会因 `SyntaxError: Unexpected token '<'` 抛错，而这个失败发生在动态 import 的 Promise 上、且早于请求处理，`try/catch` 根本包不住 —— 于是表现为"能构建、一访问就 1101"。

**修法**：页面模板改为构建期生成的纯 JS 字符串模块（`public/index.html` → `scripts/gen-page.mjs` → `src/page.mjs`），`wrangler.toml` 里那条 Text 规则同步删掉。这样页面模板就是一个普通常量，构建与运行时都不再依赖打包器规则。

**验证**：`test/page.test.mjs` 里有专门的回归断言 —— `src/` 下不允许出现任何动态 import 或 `.html` 导入。

## 已修复：上传成功但图片 URL 打不开

**这是 R2 的默认行为，不是 bug**：R2 桶默认**不对外公开**。对象确实写进桶了，但外链域名没有任何绑定能把它读出来——所以「上传成功」和「外链可打开」是两件事。

排查顺序（三条命令，30 秒定位）：

```bash
BASE=https://你的worker域名
TOKEN=你的UPLOAD_TOKEN
KEY=上传响应里的 key        # 形如 img/2026/10/xxxxxxxx.png

# ① 看外链前缀到底解析成了什么
curl -s $BASE/api/config

# ② 定点体检：对象在不在桶里 + 外链到底返回什么状态
curl -s -H "x-upload-token: $TOKEN" "$BASE/api/diag?key=$KEY"

# ③ 上传时顺手自检
curl -s -F "file=@a.png" -F verify=1 -H "x-upload-token: $TOKEN" $BASE/api/upload
```

`/api/diag?key=…` 会给出两段关键信息：

| 字段 | 含义 | 对照处理 |
| --- | --- | --- |
| `check.inBucket` | 对象在不在 R2 桶里 | `false` → 写到了别的桶（对比 `wrangler.toml` 的 `bucket_name`）或 key 不一致 |
| `check.public.status` | 外链真实 HTTP 状态 | `401/403` → **桶没公开**，按下面第 6 步绑域名或开 r2.dev |
| | | `404` → 域名通了但读不到这个 key（桶绑错） |
| `check.public.reachable` | `true` 才是真能打开 | `null` 表示没配 `R2_PUBLIC_BASE`（外链走 Worker 自己，无法自请求） |

`lint.problems` 还会顺手指出口配置错误，例如：

- `R2_PUBLIC_BASE` 漏了 `https://`；
- `R2_PUBLIC_BASE` 指向了 `.r2.cloudflarestorage.com`（那是**需要签名的 S3 API 端点**，不是公开域名）。

**根治办法**就是「部署」一节的第 6 步：R2 → 桶 → Settings → Custom Domains 绑一个域名（或开 r2.dev），再把该域名填进 `R2_PUBLIC_BASE` 重新 deploy。

> 上传页现在默认带 `verify=1`，不可达时会在页面顶部弹一条橙色告警，并给卡片加了「打开」按钮——不用再靠猜。

## 分享这个项目前：隐私自查

```bash
npm run scan-secrets              # 扫描本项目
node scripts/scan-secrets.mjs . --strict   # CI 用：连“提示项”也算失败
```

脚本会查 `.env`/`.dev.vars`/`.wrangler/`、各类 token 前缀（含 `wrangler login` 产生的 `cfoat_`/`cfort_`）、
私钥块，以及邮箱、本机路径、账号 ID 这类痕迹；AWS 官方 SigV4 测试向量会放行（公开文档里的固定值，从未绑定真实账号）。
**命中的凭据一律只显示前缀 + 长度**——扫描器的输出会进终端、CI 日志、聊天记录，回显等于把"发现泄露"变成"造成泄露"。

**这个项目已经踩过的三个坑**（前两个我已修掉）：

1. ~~`dist/` 被提交进仓库~~ —— 里面是**当时那份有 1101 bug 的旧 bundle**，分享出去会误导别人。已 `git rm --cached dist` 并把 `dist/` 加进 `.gitignore`。
2. ~~`.gitignore` 漏了 `dist/`~~ —— 这才是上一条的根因，已补上（还顺手清掉一个重复行）。
3. **提交作者邮箱曾是你的 QQ 邮箱** —— 已通过重开仓库消除：现在这个仓库只有一条提交，作者是中性身份。

其余要点（git 历史里的密钥要轮换而不是删文件、公开桶等于全网可读、LICENSE 的法律含义）见下节。

## 上传到 GitHub

这个仓库已经准备好，只差推送（推送需要在你自己的终端里做，需要有 GitHub 凭据）：

```bash
# 1. 在 GitHub 网页上先建一个空仓库，不要勾选 README/.gitignore/LICENSE（避免首次推送冲突）

# 2. 关联并推送
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main
git push -u origin main
```

首次推送会要求认证。用 **Personal Access Token**（GitHub → Settings → Developer settings → Tokens (classic) → 勾 `repo` 权限）
作为密码，或在本机执行 `gh auth login` 后改用 `gh` 流程。

推送前最后确认三件事：

```bash
git ls-files | Select-String -Pattern '\.env|dist/|\.wrangler'   # 应无输出
npm run scan-secrets                                            # 应全绿
git log --pretty='%h %an <%ae> %s'                              # 确认作者信息你想公开
```

仓库设置里的两个建议：加个 About 描述与 topics（`cloudflare-workers`、`r2`、`image-hosting`），
以及如果暂时不想被检索就设成 Private——**公开后就无法撤回历史了**。

## 排错对照表

| 现象 | 原因 / 处理 |
| --- | --- |
| `wrangler` 报 not logged in | 没登录：`npx wrangler login`，或设 `CLOUDFLARE_API_TOKEN` |
| 部署报 `Could not resolve` 某个文件 | `main` 指向写错；页面模板已是生成文件，不再依赖打包规则 |
| 打开页面报 **Error 1101 / Worker threw exception** | 先跑 `npx wrangler tail` 看真实堆栈，再 `curl -H "x-upload-token: $TOKEN" $BASE/api/diag` 看哪个 env 没配上 |
| 页面能开、上传报 500 / `缺少 R2 绑定` | `[[r2_buckets]]` 的 `binding` 必须是 `IMAGES`，`bucket_name` 要和桶名一致 |
| 上传返回 401 | 缺 `x-upload-token` 或口令不对（页面右上角保存的口令也要对） |
| 上传返回 413 | 超过 `MAX_UPLOAD_MB`，或触到 Workers 请求体上限 → 大文件改用 presign 模式 |
| 上传返回 415 | 文件头不是可识别的图片格式（服务端只认魔数，不看 `Content-Type`） |
| 上传成功但打开直链 401 / 403 / 打不开 | **最常见**：R2 桶没开公开访问。见上面「上传成功但图片 URL 打不开」一节 |
| 上传成功但打开直链 404 | 域名通了但桶绑错，或 key 不一致：`/api/diag?key=…` 看 `inBucket` |
| `R2_PUBLIC_BASE` 看着配了却没生效 | 漏了 `https://`，或指向了 `.r2.cloudflarestorage.com`（S3 端点需签名）。`/api/diag` 的 `lint.problems` 会指出来 |
| presign 模式浏览器报 CORS | 桶的 CORS 没配，或 `AllowedOrigins` 没含你的 Worker 域名 |
| presign 模式报 500 | 少了 `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` 三个 secret |
| 删除接口 403 | 没设 `DELETE_TOKEN`，删除功能默认关闭 |
| 改了 `UPLOAD_MODE` 但没生效 | `vars` 改动需要重新 `npx wrangler deploy`（secrets 不用） |

## 配置项

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `R2_BUCKET` | — | 桶名（仅用于展示与拼 S3 URL） |
| `UPLOAD_MODE` | `direct` | `direct` 或 `presign` |
| `KEY_PREFIX` | `img` | 对象 key 前缀，最终形如 `img/2025/06/<sha256前24位>.png` |
| `MAX_UPLOAD_MB` | `20` | 单文件上限 |
| `PRESIGN_EXPIRES` | `900` | 预签名有效期（秒），最长 7 天 |
| `R2_PUBLIC_BASE` | 空 | 外链前缀，**必须带 `https://`**，如 `https://img.example.com`（桶绑定的公开域名）。留空则回落到 Worker 部署域名 + `/i/`。**不能**漏协议头、不能填 S3 端点、不要写路径 |
| `RATE_LIMIT_PER_MIN` | `0` | 每 IP 每分钟上传次数；`0` 表示不限制 |
| `UPLOAD_TOKEN` / `DELETE_TOKEN` | 空 | **用 secret 配置**；后者留空则删除接口禁用 |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | — | 仅 presign 模式需要 |

限流优先用 Rate Limiting 绑定（`env.RATE_LIMITER`），没配或绑定抛错时退回 isolate 内的内存计数（尽力而为，跨 isolate 不共享）。

## API

与 Node 版保持一致，方便互换：

```bash
# 上传（字段名 file，可多文件）
curl -F "file=@a.png" -H "x-upload-token: $UPLOAD_TOKEN" https://你的域名/api/upload

# 只要图片直链：直接跟随重定向
curl -L -F "file=@a.png" -H "x-upload-token: $UPLOAD_TOKEN" "https://你的域名/api/upload?redirect=1"

# 删除
curl -X POST https://你的域名/api/delete \
     -H "content-type: application/json" -H "x-delete-token: $DELETE_TOKEN" \
     -d '{"key":"img/2025/06/xxxx.png"}'

# 健康检查（配了口令时需带口令，否则只回 authRequired）
curl -H "x-upload-token: $UPLOAD_TOKEN" https://你的域名/api/health

# 页面用的公开配置（可匿名读，不含桶名）
curl https://你的域名/api/config

# 排错：只回报哪些 env/绑定存在，不回报任何值
curl -H "x-upload-token: $UPLOAD_TOKEN" https://你的域名/api/diag

# 历史清单：直接列桶，最新在前（受口令保护）
curl -H "x-upload-token: $UPLOAD_TOKEN" "https://你的域名/api/list?months=2&limit=200"
curl -H "x-upload-token: $UPLOAD_TOKEN" "https://你的域名/api/list?month=2026-10"   # 只看某个月
curl -H "x-upload-token: $UPLOAD_TOKEN" "https://你的域名/api/list?q=a4bcd7"        # 按 key 搜索
```

`presign` 模式的上传响应里会多出 `uploadUrl`、`uploadHeaders`、`skipUpload`；浏览器拿到后自行 `PUT` 即可（`public/index.html` 已经实现）。

上传时加 `-F verify=1`（页面上默认开启），响应会多出外链可达性自检结果：

```json
{
  "ok": true,
  "reachableCount": 0,
  "unreachableCount": 1,
  "hint": "文件已写入 R2，但外链打不开：R2 桶默认不公开，请在桶的 Settings 里绑自定义域名或开启 r2.dev，并把域名填进 R2_PUBLIC_BASE",
  "files": [
    { "key": "img/2026/10/xxxx.png", "url": "https://img.example.com/img/2026/10/xxxx.png",
      "verify": { "reachable": false, "status": 403, "note": "外链返回 403：桶没开公开访问，或自定义域名未生效（R2 默认不公开）" } }
  ]
}
```

## 历史图片清单（列桶）

页面顶部有 **上传 / 历史图片** 两个标签页。「历史图片」不依赖浏览器缓存，而是**直接列 R2 桶**——换设备、清缓存都还在。

### 为什么不是简单地 list 一遍

R2 的 `list()` 有两个约束，决定了这里必须绕着走：

1. **按 key 字典序返回，且从最旧开始**，没有"倒序"选项。我们的 key 是 `img/YYYY/MM/<hash>.png`，直接翻页只能从最老的桶底开始爬。
2. **`list()` 是 Class A 操作，会计费**，不能无脑翻全桶。

所以实现是「**近 N 个月的前缀倒序扫描**」：默认扫最近 2 个月（`months` 参数最大 12），每个月一次 `list` 调用，合并后按对象的上传时间倒序。代价是 list 调用次数 = 月份数——`/api/list` 的响应里会如实回报 `listCalls`，不会藏着。

如果某个月的图片数超过单次扫描上限（1000 条），响应会带 `truncated: true` 和一条 `note`，提示改用 `?month=YYYY-MM` 精确查看那个月，而不是悄悄少给你。

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `months` | `2` | 往前扫几个月（1–12） |
| `month` | — | 只扫指定月份，格式 `YYYY-MM`；与 `months` 二选一 |
| `limit` | `200` | 最多返回多少条（1–1000） |
| `q` | — | 按 key 子串过滤（不区分大小写） |

### 响应（节选）

```json
{
  "ok": true,
  "publicBase": "https://img.example.com",
  "objects": [
    {
      "key": "img/2026/10/a4bcd7b80c65e14e3809783f.png",
      "name": "a4bcd7b80c65e14e3809783f.png",
      "size": 70,
      "uploaded": "2026-10-09T05:41:30.000Z",
      "contentType": "image/png",
      "etag": "\"etag-1-70\"",
      "url": "https://img.example.com/img/2026/10/a4bcd7b80c65e14e3809783f.png",
      "thumbUrl": "https://img.example.com/…",
      "markdown": "![…](https://img.example.com/…)"
    }
  ],
  "monthsScanned": 2, "listCalls": 2, "returned": 8, "hasMore": false, "truncated": false
}
```

两个细节：

- **`thumbUrl`**：配了 `R2_PUBLIC_BASE` 时与 `url` 相同（直连 R2）；没配时给 `<部署域名>/i/<key>`，保证缩略图一定加载得出来。页面上还有「缩略图走直链」开关，直链加载失败会自动退回代理，不会整屏空白。
- **`uploaded` 与 key 里的月份可能差一天**：key 用的是 UTC 上传日期，跨月/跨时区时会略有出入；排序以 `uploaded` 为准。

### 安全

`/api/list` **必须**配 `UPLOAD_TOKEN` 才可用（没配直接 403）——列桶等于把整个桶的目录交出去，不能匿名开放。

## 限制与注意

- **Workers 请求体上限**：免费/付费计划的请求体大小有限制，`direct` 模式传大图容易被平台先挡掉。要传大文件请用 `presign` 模式，或让客户端分片。
- **CPU 时间**：哈希用的是 WebCrypto（原生实现），对大文件不算重；但 `direct` 模式会把整个文件读进内存，注意 `MAX_UPLOAD_MB` 别设太大。
- **只信魔数**：与 Node 版一致，按文件头判断真实类型，客户端声明的 `Content-Type` 不作为放行依据。
- **删除护栏**：只接受以 `KEY_PREFIX/` 开头、不含 `..` 与 `//` 的 key。
- **`/i/` 冷启动**：未绑域名时每次读图都要过一次 Worker，建议还是绑自定义域名。

## 测试

```bash
npm test          # 依次跑 page / sigv4 / worker 三个套件
```

- `test/page.test.mjs`（18 条）：校验 `src/page.mjs` 与 `public/index.html` 逐字节一致、占位符完整、没有依赖打包器规则。
- `test/sigv4.test.mjs`（20 条）：复现 AWS 官方 SigV4 测试向量，并把 **WebCrypto 实现与 Node 版 `node:crypto` 实现逐字节比对**（预签名 URL 必须完全一致），覆盖空格/加号/中文的 RFC3986 编码。
- `test/worker.test.mjs`（143 条）：直接把 Worker 的 `fetch` 跑在 Node 里，R2 绑定用 `test/mock-r2.mjs` 的内存替身，覆盖两种上传模式、去重、魔数校验、体积上限、`redirect=1`、`/i/` 的 ETag/Range/HEAD/穿越防护、删除护栏、限流降级、CORS 预检、`/api/diag`、非法 `R2_PUBLIC_BASE` 的回落，以及 `/api/list` 的倒序/分页/搜索/月份参数/截断告警。

> `mock-r2.mjs` 是测试替身，不是 R2 的完整仿真；它只实现 `worker.mjs` 用到的那部分 API。
> 测试不覆盖 wrangler 的打包与部署行为，那些要靠 `npm run dry-run` 和你机器上的实际输出。
