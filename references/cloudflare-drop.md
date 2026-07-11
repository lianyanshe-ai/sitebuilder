# Cloudflare Drop · 部署说明

## 产品要点

- **入口**: [https://cloudflare.com/drop](https://cloudflare.com/drop)
- **能力**: 拖入文件夹或 ZIP → 全球网络临时预览
- **无需账号**: 可直接获得临时预览链接
- **有效期**: 未认领预览约 **1 小时（60 分钟）**
- **永久保留**: 在有效期内点击 **Claim**，登录或注册 Cloudflare 账号
- **静态限制**: HTML、CSS、JavaScript、图片、字体（无服务端运行时）
- **体积参考**: 前端校验约单文件 ≤25MB 量级、总包 ≤100MB；Workers Static Assets 临时账号约 1000 文件 / 单文件 5MiB

## 与 Wrangler Temporary 的关系

| | Cloudflare Drop UI | `wrangler deploy --temporary` |
|--|-------------------|-------------------------------|
| 入口 | 浏览器拖放 | CLI（AI Agent 官方路径） |
| 账号 | 不需要 | 不需要（未登录时） |
| 预览 | 临时 URL | `*.workers.dev` |
| 认领 | 页面 Claim 按钮 | `https://dash.cloudflare.com/claim-preview?claimToken=...` |
| TTL | ~1 hour | 60 minutes |
| 底层 | provisioning/previews + Workers Assets | 同一套 temporary preview account |

**sitebuilder 默认用 `drop` 方法**（Drop 同源 provisioning API，无需用户 API，通常 ~15s）。  
`temporary`（wrangler）仅作回退；真开网页可用 `drop-browser`；纯手动用 `zip-only`。

文档：

- [Cloudflare Drop changelog](https://developers.cloudflare.com/changelog/post/2026-07-08-cloudflare-drag-and-drop/)
- [Claim deployments](https://developers.cloudflare.com/workers/platform/claim-deployments/)

## Drop 网页底层 API（逆向备忘，可能变更）

```
POST https://api.cloudflare.com/client/v4/provisioning/previews/challenge
POST https://api.cloudflare.com/client/v4/provisioning/previews
  body: { client, source:"drop", termsOfService, privacyPolicy, acceptTermsOfService, challengeToken, solution }
→ account.id, account.apiToken, claim.token, claim.url, expiresAt

POST /accounts/:id/workers/scripts/:name/assets-upload-session  (Bearer apiToken)
POST /accounts/:id/workers/assets/upload?base64=true
PUT  /accounts/:id/workers/scripts/:name  (metadata + assets jwt)
POST /accounts/:id/workers/scripts/:name/subdomain { enabled: true }
```

PoW challenge 由浏览器 Web Worker 求解；CLI 场景优先 wrangler。

## Claim 操作

1. 部署完成后拿到 `claimUrl`
2. 在浏览器打开（可 `deploy.mjs --open-claim`）
3. 登录已有账号或注册新账号（新账号需验证邮箱）
4. Claim 成功后可绑自定义域、可观测性、Access 等

**安全**: Claim URL 等同所有权凭证，勿公开发布到不可信渠道。

## sitebuilder 命令

```bash
# 默认：Drop 同源 API（推荐，快，无需用户 API）
node scripts/deploy.mjs /path/to/project --json

# 仅 Drop，失败不回退
node scripts/deploy.mjs /path/to/project --method drop --no-fallback --json

# 备选：wrangler temporary（较慢）
node scripts/deploy.mjs /path/to/project --method temporary --json

# 仅打包 zip，手动上 Drop
node scripts/deploy.mjs /path/to/project --method zip-only

# Playwright 自动化 Drop 页（需 playwright）
node scripts/deploy.mjs /path/to/project --method drop-browser

# 打开 Claim
node scripts/deploy.mjs /path/to/project --open-claim
```

结果写入项目 `.sitebuilder/last-deploy.json`。

## 默认链路

1. **`drop`** — `scripts/drop-api.mjs`：challenge → PoW → provision → upload → workers.dev  
2. 失败则 **`temporary`**（wrangler）  
3. 再失败则 **`zip-only`** 给出手动拖放指引
