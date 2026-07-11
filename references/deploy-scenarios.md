# 部署输入场景（主功能）

sitebuilder 会自动识别路径类型，再决定如何打包上传。

## A) 单个 HTML 文件

```bash
node scripts/deploy.mjs "/path/to/报告.html" --json
```

行为：

- 复制为暂存目录中的 `index.html`（Drop 首页必须是 index）
- **只附带 HTML 真实引用的本地资源**（`src` / `href` / `url()` / `srcset`）
- 仅当存在**与文件名匹配**的侧车目录时才整夹拷贝：`报告_files/`、`报告.files/`
- **默认不**把父目录里其它图片/截图/杂文件打进去（避免 Downloads 爆炸）
- 显式需要同级静态文件时：`--include-siblings`（有数量/体积上限；Downloads/Desktop 仍拒绝）

适用：导出的长文、单页报告、Landing 单文件。

---

## B) 静态资源文件夹

```bash
node scripts/deploy.mjs "/path/to/site-folder" --json
```

识别条件：目录内有 `index.html`，或有若干 `.html` + 静态资源（**不是**带 `package.json` 的工程）。

行为：

| 目录状态 | 处理 |
|----------|------|
| 有 `index.html` | 直接作为产物根上传 |
| 仅 1 个非 index 的 html | 暂存为 index.html |
| 多个 html、无 index | 复制整夹，并用「最大/最像首页」的 html 作为 index.html |
| 子目录有 `dist/` 等 | 自动选用带 index 的产物子目录 |

**不要**把整个 `Downloads/` 当静态夹上传（体积会爆）。

---

## C) 前端工程项目

```bash
# 已 build 过
node scripts/deploy.mjs "/path/to/vite-app" --json

# 还没有 dist：自动 npm/pnpm/yarn build
node scripts/deploy.mjs "/path/to/vite-app" --build --json

# 产物不在默认路径
node scripts/deploy.mjs "/path/to/app" --dir apps/web/dist --json
```

识别条件：存在 `package.json` / `vite.config.*` / `next.config.*` 等。

自动查找产物（含 monorepo）：

`dist` `build` `out` `public` `apps/web/dist` `client/dist` `frontend/dist` …

| 情况 | 处理 |
|------|------|
| 已有 dist + index.html | 直接部署 |
| 无产物 + `--build` | 执行 `npm/pnpm/yarn run build` 后再部署 |
| 无产物且未 `--build` | 报错并提示先 build / 加 `--build` / `--dir` |
| Next 等需 SSR | 仅支持 **静态导出**（`output: 'export'` → `out/`） |

**禁止**把含大量 `.ts/.tsx/.vue` 的源码树当静态站上传。

---

## Agent 决策树

```
输入 path
  ├─ 是 .html 文件?     → A 单文件
  ├─ 有 package.json / vite|next 配置? → C 工程（找 dist 或 --build）
  ├─ 有 index.html / 静态 html? → B 静态夹
  └─ 否则 → 清晰报错（三种用法示例）
```

部署成功门槛（与场景无关）：

- HTTP 200
- `Content-Type: text/html`（否则浏览器会下载）
- 正文像真实页面（非 CF 404 壳）
