# Sitebuilder · 建站风格应用指南（次要路径）

> **注意**：sitebuilder 主功能是「部署本地静态站到 Cloudflare Drop」。  
> 本文件仅在用户**从零设计/新建站点**时使用。纯部署场景不要走风格流程。

基于 [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md/tree/main/design-md) 的 DESIGN.md。

## 两种选风格模式

### 1) 自动匹配

根据用户对站点的描述（行业、情绪、明暗、受众）打分，选出最合适的风格：

```bash
node scripts/match-style.mjs "加密货币交易仪表盘，暗色，专业" --json
node scripts/fetch-style.mjs <recommended-id> --project <siteDir>
```

### 2) 手动指定

```bash
node scripts/fetch-style.mjs tesla --project <siteDir>
node scripts/fetch-style.mjs figma --project <siteDir>
node scripts/fetch-style.mjs binance --project <siteDir>
node scripts/fetch-style.mjs claude --project <siteDir>   # OpenAI 别名也映射到 claude
```

别名：`tsla`→tesla，`openai`→claude，`linear`→linear.app，`xai`→x.ai 等（见 `styles-catalog.json`）。

## Agent 建站时如何「还原」风格

读取项目根目录 `DESIGN.md` 后，**必须**落实下列维度（不可只换主色）：

| 维度 | 落实方式 |
|------|----------|
| 配色方案 | 所有颜色来自 DESIGN.md token/hex；禁止临时发明品牌色 |
| 排版规则 | Display / Body / Mono 字体栈 + 字号层级 +字重 + letter-spacing |
| 组件样式 | 按钮（primary/secondary）、卡片、输入框、导航的圆角/padding/状态 |
| 布局结构 | 间距刻度、网格/最大宽度、hero 是否全屏、章节节奏 |
| 交互动效 | 过渡时长/缓动（如 Tesla 0.33s）；是否禁用阴影/缩放 hover |

### 实现约束（静态站）

- 纯静态：HTML + CSS + JS（可 Vite/静态导出）
- 字体：优先 Google Fonts / fontsource 开源替代；专有字体用文档中的 substitute
- 产出目录：`dist/` 或 `build/`，根级必须有 `index.html`
- 不要引入需要服务端的 API 路由（Drop 不跑后端）

### 推荐页面骨架（落地页）

1. **Nav** — 按风格：透明浮层 / 实心条 / 暗色顶栏  
2. **Hero** — 全屏摄影（Tesla）或色块叙事（Figma）或数据宣称（Binance）  
3. **Features / Social proof** — 卡片网格或色块分节  
4. **CTA band** — 单一主色按钮  
5. **Footer** — 按风格：浅色收尾（Binance）或反色（Figma inverse）

### 风格速查（高频）

| ID | 标志特征 |
|----|----------|
| `tesla` | 极简减法、100vh 摄影、唯一蓝色 CTA `#3E6AE1`、无阴影无渐变、4px 圆角 |
| `figma` | 黑白框架 + 大面积马卡龙色块、pill 按钮、细字重可变字体感 |
| `binance` | 近黑底 + 黄 `#FCD535` CTA、黑字压黄、涨跌绿红、交易桌密度 |
| `claude` | 暖陶土色、编辑式留白、温和 AI 气质 |
| `vercel` | 黑白精密、Geist/Inter、开发者极简 |
| `stripe` | 紫渐变、轻字重优雅、支付级信任感 |
| `linear.app` | 极致极简、紫色点缀、工程师审美 |
| `x.ai` | 硬核黑白未来感 |

## 自检清单

- [ ] 主 CTA 颜色与形状是否与 DESIGN.md 一致（而非「通用蓝按钮」）  
- [ ] 是否出现风格明确禁止的元素（如 Tesla 阴影、Binance 第二品牌色）  
- [ ] 字体层级是否收敛到文档表格  
- [ ] 移动端断点是否按文档折叠  
- [ ] `dist/` 仅含静态资源且存在 `index.html`  
