---
name: sitebuilder
description: >
  Deploy a finished local static site to Cloudflare Drop and get a shareable preview URL
  (no Cloudflare API token). Primary: upload dist/build/index.html or a static folder via
  cloudflare.com/drop. Secondary: only when building a site from scratch, match styles via
  awesome-design-md. Triggers: sitebuilder, cloudflare, one-click deploy, upload static site,
  Cloudflare Drop, preview link, share link, /sitebuilder; also "design from scratch / use XX style".
  中文：本地静态站一键上传 Cloudflare Drop 拿预览链接（无需 API）；从零建站时才做风格匹配。
license: MIT
metadata:
  author: sitebuilder contributors
  version: "1.0.0"
  requires:
    node: ">=18"
---

# Sitebuilder

**一句话（主功能）**：本地静态站开发完成 → 一键丢上 Cloudflare Drop → 拿到预览链接分享测试。

**设计风格是次要能力**：只有用户**从零设计 / 新建站点**时才问风格、拉 DESIGN.md；  
已有本地网页要上线时，**直接部署，不要谈风格、不要 match-style**。

```
【主路径 · 部署】
  本地项目（dist/build/index.html）
    → package 校验 → deploy（Drop，无 API）
    → Preview URL（~1h）→ 可选 Claim

【次路径 · 从零建站】（仅用户明确要设计/新建时）
  需求 → 自动匹配或手动指定风格 → 生成静态站 → 再走主路径部署
```

**BASE** = 本 `SKILL.md` 所在目录（安装后常见路径：`~/.agents/skills/sitebuilder`、`~/.claude/skills/sitebuilder` 等；以实际安装位置为准）。

---

## 意图路由（先判再做）

| 用户说法 | 走哪条 | 注意 |
|----------|--------|------|
| 「部署 / 上线 / 预览链接 / 上传 / Drop / 分享给同事」 | **主路径：只部署** | 不提风格、不拉 DESIGN.md |
| 「把这个项目 / dist 丢上 Cloudflare」 | **主路径：只部署** | 同上 |
| 「从零做个站 / 帮我设计落地页 / 新建页面」 | **次路径：风格 + 生成 + 部署** | 此时才提供风格选择 |
| 「用 Tesla/Figma 风格做…」 | **次路径** | 手动风格 |
| 「Claim / 永久保留」 | Claim 流程 | 打开 claimUrl |

**默认假设**：用户已经有本地静态产物，目标是上传。  
**禁止**：用户只说「部署 sitebuilder」时，仍去 match 风格或重做设计。

---

## 硬约束（部署时必须告知）

1. **仅静态资源**：HTML、CSS、JavaScript、图片、字体  
2. **未认领预览约 1 小时**后失效  
3. **无需 Cloudflare 账号 / 无需用户提供 API** 即可临时预览  
4. **永久保留**需在有效期内 **Claim** 并登录 Cloudflare  
5. 体积建议：总包 &lt; 100MB；文件数约 ≤ 1000  

---

## 主路径 · 部署本地静态站（默认）

### 三种输入（脚本自动识别，详见 `references/deploy-scenarios.md`）

| 场景 | 输入例子 | 脚本行为 |
|------|----------|----------|
| **A. 单 HTML** | `…/报告.html` | 暂存为 `index.html`，并附带同级 `assets/css/js/images` |
| **B. 静态文件夹** | `…/site/`（有 index 或若干 html） | 直接上传；无 index 时选入口 html 作首页 |
| **C. 前端工程** | `…/vite-app/`（有 package.json） | 用 `dist/build/out/…`；无产物可加 `--build` |

### 何时走主路径

- 用户说部署、上线、预览、分享、Drop、上传  
- 有现成网页文件 / 静态夹 / 工程产物  

### 命令

```bash
# A) 单个 HTML（中文文件名 OK）
node "$BASE/scripts/deploy.mjs" "/path/to/报告.html" --json

# B) 静态文件夹
node "$BASE/scripts/deploy.mjs" "/path/to/static-site" --json

# C) 前端工程（已有 dist）
node "$BASE/scripts/deploy.mjs" "/path/to/vite-app" --json

# C') 工程还没 build：自动构建再部署
node "$BASE/scripts/deploy.mjs" "/path/to/vite-app" --build --json

# 产物路径特殊时
node "$BASE/scripts/deploy.mjs" "/path/to/app" --dir apps/web/dist --json

# 仅校验解析（不上传）
node "$BASE/scripts/package-static.mjs" "/path/to/…" --json

# 打开 Claim
node "$BASE/scripts/deploy.mjs" "/path/to/…" --open-claim
```

### Agent 执行清单（主路径）

1. 把用户给的路径原样传给 `deploy.mjs`（**不要**先臆测改路径）  
2. 看 JSON 里的 `scenario`：`html-file` | `static-folder` | `project`  
3. 若报错「工程无产物」→ 用 `--build` 重试，或让用户先 `npm run build`  
4. 解析 `previewUrl` / `claimUrl` / `contentType` / `verified`  
5. 交付时**不要**夹带风格推荐  
6. 元数据：`.sitebuilder/last-deploy.json`  

**部署成功判定（硬门槛）**：`Content-Type: text/html` + HTTP 200 + 正文像真页面（`verified: true`）。  
若是 `application/octet-stream` 浏览器会下载——脚本应失败而非交付。

**常见坑**：
- 整包 `Downloads/` → 体积超限  
- 工程源码目录未 build → 加 `--build` 或 `--dir dist`  
- Next 未 static export → 无 `out/`，需 `output: 'export'`  
- 单 HTML 文件名不是 index → 已自动暂存

### 部署方法

| method | 默认？ | 说明 |
|--------|--------|------|
| `drop` | ✅ | Drop 同源 API，快，无用户 API |
| `temporary` | 回退 | wrangler temporary，较慢 |
| `drop-browser` | 备选 | Playwright 真开 Drop 页 |
| `zip-only` | 备选 | 打 zip，用户手动拖 https://www.cloudflare.com/drop/ |

---

## 次路径 · 从零设计建站（仅明确新建时）

**触发条件（须同时近似满足）**：

- 没有可部署的本地静态产物，**且**
- 用户明确要「设计 / 新建 / 从零做 / 用某风格做站」

**未触发时禁止**：自动 match 风格、询问「要不要 Tesla 还是 Figma」、生成 DESIGN.md。

### 1. 选风格（仅次路径）

**自动匹配**

```bash
node "$BASE/scripts/match-style.mjs" "用户需求简述" --top 5 --json
node "$BASE/scripts/fetch-style.mjs" "<recommended>" --project "/path/to/site" --json
```

**手动指定**

```bash
node "$BASE/scripts/fetch-style.mjs" --list
node "$BASE/scripts/fetch-style.mjs" tesla|figma|binance|claude --project "/path/to/site"
# 别名：tsla→tesla, openai→claude, linear→linear.app, xai→x.ai
```

来源：[awesome-design-md](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md)；  
索引 `references/styles-catalog.json`；细则 `references/build-guide.md`。

### 2. 生成静态站

1. 读取 `DESIGN.md`，还原配色 / 排版 / 组件 / 布局 / 动效（不可只换主色）  
2. 产出纯静态 HTML/CSS/JS → `dist/`，含 `index.html`  
3. **立即进入主路径部署**（用户从零做站的终点仍是预览链接）  

### 3. 生成门禁

- 颜色可追溯 DESIGN.md；CTA 符合风格；无服务端依赖；移动端基本可用  

---

## Claim 永久保留

1. 读 `.sitebuilder/last-deploy.json` 的 `claimUrl`  
2. 指引用户浏览器打开 → 登录 Cloudflare → Claim（约 1h 内）  
3. Claim 链接敏感，勿公开张贴  

```bash
node "$BASE/scripts/deploy.mjs" "/path/to/project" --open-claim
```

---

## 交付话术

### 主路径（部署）

```
✅ 本地静态站已上传到 Cloudflare Drop（无需 API）
🔗 预览: <previewUrl>
⏱ 未认领约 1 小时有效，可直接分享测试
🔐 永久保留: <claimUrl>（登录 Cloudflare Claim）
📦 产物: <buildDir>（N files）
```

### 次路径（从零建站后再部署）

在主路径模板上**额外**一行：`🎨 风格: <styleId>`。

---

## 脚本一览

| 脚本 | 主/次 | 作用 |
|------|-------|------|
| `scripts/deploy.mjs` | **主** | 一键部署（drop → temporary → zip-only） |
| `scripts/drop-api.mjs` | **主** | Drop 同源 API 内核 |
| `scripts/package-static.mjs` | **主** | 三场景解析 + 校验静态 + zip |
| `references/deploy-scenarios.md` | **主** | A/B/C 输入场景说明 |
| `scripts/match-style.mjs` | 次 | 从零建站时自动匹配风格 |
| `scripts/fetch-style.mjs` | 次 | 从零建站时拉取 DESIGN.md |
| `references/cloudflare-drop.md` | 主 | Drop / Claim 说明 |
| `references/styles-catalog.json` | 次 | 风格目录 |
| `references/build-guide.md` | 次 | 风格还原指南 |

依赖：Node 18+；默认 Drop **不需要**用户 API / wrangler。  
回退 `temporary` 需网络拉 wrangler；`drop-browser` 需 playwright。

---

## 示例

### 主功能（默认场景）

用户：`把 ./my-landing 部署到 Cloudflare 给我预览链接`

```bash
# 若需要先 build
# cd ./my-landing && npm run build

node "$BASE/scripts/deploy.mjs" "./my-landing" --json
# → previewUrl + claimUrl
# 不要问风格
```

### 次功能（从零）

用户：`从零做个 AI 工具落地页，自动选风格，然后上线`

```bash
node "$BASE/scripts/match-style.mjs" "AI coding tool landing dark" --json
node "$BASE/scripts/fetch-style.mjs" cursor --project "$SITE"
# 生成 dist → deploy
node "$BASE/scripts/deploy.mjs" "$SITE" --json
```

---

## Red Flags

- **用户只要部署，却先聊风格 / 重做设计**（主次颠倒）  
- 服务端项目未静态导出就 Drop  
- 忘记提示 **1 小时 TTL**  
- 无 `index.html` 导致预览 404  
- 把 claimUrl 当普通分享链接广而告之  
- 从零建站时只换主色却声称完整品牌风格  
