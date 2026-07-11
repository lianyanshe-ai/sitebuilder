<div align="center">

# Sitebuilder

**本地静态站 → 一键上 Cloudflare Drop → 拿到可分享预览链接**

无需 Cloudflare API Token · 无需登录 · Node 18+

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Agent Skills](https://img.shields.io/badge/skills.sh-compatible-blueviolet)](https://skills.sh)
[![Node](https://img.shields.io/badge/Node.js-18%2B-brightgreen)](https://nodejs.org)

</div>

---

## 安装（一行命令）

把本 skill 装到本地 AI Agent（Claude Code / Cursor / Codex / Copilot / Windsurf / OpenCode 等）：

```bash
# 推荐：通过 GitHub 仓库一键安装
npx skills add lianyanshe-ai/sitebuilder -g -y
```

也可以用完整 URL：

```bash
npx skills add https://github.com/lianyanshe-ai/sitebuilder -g -y
```

> `-g` = 装到用户级全局 skill 目录  
> `-y` = 跳过确认提示  

### 手动安装

```bash
# 克隆到任意 agent skill 目录
git clone https://github.com/lianyanshe-ai/sitebuilder.git ~/.agents/skills/sitebuilder

# 或 Claude Code
git clone https://github.com/lianyanshe-ai/sitebuilder.git ~/.claude/skills/sitebuilder

# 或 Grok / 其他支持 .agents 的工具
git clone https://github.com/lianyanshe-ai/sitebuilder.git ~/.grok/skills/sitebuilder
```

安装后，对 agent 说：

```
把 ./my-landing 部署到 Cloudflare，给我预览链接
```

---

## 它做什么

| 能力 | 说明 |
|------|------|
| **主功能 · 一键部署** | 把本地 `dist/` / 静态文件夹 / 单个 HTML 上传到 [Cloudflare Drop](https://www.cloudflare.com/drop/)，返回预览 URL |
| **无需 API** | 默认走 Drop 同源接口，用户不用提供 Cloudflare Token |
| **三场景自动识别** | 单 HTML · 静态文件夹 · 前端工程（Vite/React/Next 等） |
| **次功能 · 从零建站** | 仅当用户明确要求「设计/新建」时，才匹配风格并生成静态站（[awesome-design-md](https://github.com/VoltAgent/awesome-design-md)） |

```
本地项目 → package 校验 → deploy（Drop）→ Preview URL（~1h）→ 可选 Claim 永久保留
```

### 硬限制（请提前告知用户）

1. **仅静态资源**：HTML / CSS / JS / 图片 / 字体  
2. **未认领预览约 1 小时**后失效  
3. 永久保留需在有效期内 **Claim** 并登录 Cloudflare  
4. 体积建议：总包 < 100MB，文件数约 ≤ 1000  

---

## 快速上手（CLI）

安装 skill 后，`BASE` = skill 所在目录（例如 `~/.agents/skills/sitebuilder`）。

```bash
# A) 单个 HTML
node "$BASE/scripts/deploy.mjs" "/path/to/报告.html" --json

# B) 静态文件夹
node "$BASE/scripts/deploy.mjs" "/path/to/static-site" --json

# C) 前端工程（已有 dist）
node "$BASE/scripts/deploy.mjs" "/path/to/vite-app" --json

# C') 工程还没 build：自动构建再部署
node "$BASE/scripts/deploy.mjs" "/path/to/vite-app" --build --json

# 仅校验、不上传
node "$BASE/scripts/package-static.mjs" "/path/to/…" --json

# 打开上次部署的 Claim 链接
node "$BASE/scripts/deploy.mjs" "/path/to/…" --open-claim
```

成功时 JSON 会包含：

- `previewUrl` — 可分享预览  
- `claimUrl` — 认领永久保留（敏感，勿公开张贴）  
- `verified` — 预览页是否为真实 HTML  

---

## 对 Agent 说什么

| 你说 | Skill 行为 |
|------|------------|
| 「部署 / 上线 / 预览链接 / 上传 Drop」 | **只部署**，不聊风格 |
| 「把这个 dist 丢上 Cloudflare」 | **只部署** |
| 「从零做个落地页 / 用 Tesla 风格建站」 | 匹配风格 → 生成 → 再部署 |
| 「Claim / 永久保留」 | 打开 claimUrl |

**默认假设**：用户已有本地静态产物，目标是上传。  
**禁止**：用户只要部署时，仍去 match 风格或重做设计。

---

## 仓库结构

```
sitebuilder/
├── SKILL.md                 # Agent Skill 入口（YAML frontmatter + 指令）
├── README.md                # 本文件
├── LICENSE                  # MIT
├── scripts/
│   ├── deploy.mjs           # 一键部署（主入口）
│   ├── drop-api.mjs         # Cloudflare Drop 同源 API
│   ├── package-static.mjs   # 三场景解析 + 校验 + zip
│   ├── match-style.mjs      # 从零建站：风格匹配
│   └── fetch-style.mjs      # 从零建站：拉取 DESIGN.md
└── references/
    ├── deploy-scenarios.md  # A/B/C 输入场景
    ├── cloudflare-drop.md   # Drop / Claim 说明
    ├── build-guide.md       # 风格还原指南
    └── styles-catalog.json  # 风格目录
```

符合 [Agent Skills](https://agentskills.io/) / [skills.sh](https://skills.sh) 约定：仓库根目录有 `SKILL.md` 即可被 `npx skills add` 识别。

---

## 依赖

| 场景 | 依赖 |
|------|------|
| 默认 `drop` 部署 | **Node.js 18+**，无其它 npm 依赖 |
| 回退 `temporary` | 需网络拉取 `wrangler` |
| `drop-browser` | 可选安装 `playwright` |

```bash
# 可选：浏览器自动化回退
npm i -D playwright && npx playwright install chromium
```

---

## 更新 / 卸载

```bash
# 更新到最新
npx skills update sitebuilder -g -y

# 卸载
npx skills remove sitebuilder -g -y
```

手动安装则：

```bash
cd ~/.agents/skills/sitebuilder && git pull
# 或
rm -rf ~/.agents/skills/sitebuilder
```

---

## 安全与合规说明

- 默认 **不需要** 用户提供 Cloudflare API Token  
- Drop 使用 Cloudflare 官方临时预览能力；未认领预览有 TTL  
- `claimUrl` 可认领部署，**不要**当普通分享链接广而告之  
- 脚本仅上传你指定的静态目录，请勿把含密钥的源码树整包部署  
- Cloudflare Drop / provisioning API 属第三方服务，行为以 Cloudflare 文档为准  

---

## 贡献

欢迎 Issue / PR。改动建议：

1. 保持 **主路径 = 只部署** 的默认行为  
2. 脚本以 Node 原生 ESM 为主，尽量零依赖  
3. 部署成功判定：`Content-Type: text/html` + HTTP 200 + `verified: true`  

---

## License

[MIT](LICENSE)

---

## English (short)

**Sitebuilder** is an [Agent Skill](https://skills.sh) that deploys local static sites to [Cloudflare Drop](https://www.cloudflare.com/drop/) and returns a shareable preview URL — **no API token required**.

```bash
npx skills add lianyanshe-ai/sitebuilder -g -y
```

Then ask your agent: *"Deploy ./my-landing to Cloudflare and give me the preview link."*

- Primary path: package → Drop upload → `previewUrl` (~1h unclaimed)  
- Optional claim for permanent retention  
- Secondary path (only when you ask to design from scratch): style match via [awesome-design-md](https://github.com/VoltAgent/awesome-design-md) → generate static site → deploy  

Requires **Node.js 18+**. MIT licensed.
