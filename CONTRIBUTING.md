# Contributing to sitebuilder

感谢你的贡献。本仓库是一个 [Agent Skill](https://agentskills.io/)：根目录 `SKILL.md` + `scripts/` + `references/`。

## 开发环境

- Node.js 18+
- 无需 API Key 即可测试默认 `drop` 路径（会访问 Cloudflare 公网接口）

```bash
git clone https://github.com/lianyanshe-ai/sitebuilder.git
cd sitebuilder
npm run check
```

## 本地试跑

```bash
# 只解析、不上传
node scripts/package-static.mjs ./path/to/static --json

# 真部署（产生 ~1h 临时预览）
node scripts/deploy.mjs ./path/to/static --json
```

## 设计原则

1. **主路径永远是部署**——用户只说「部署」时，禁止 match 风格 / 重做设计  
2. 脚本优先 **零 npm 依赖**（Node 原生 ESM）  
3. 部署成功硬门槛：`Content-Type: text/html` + HTTP 200 + `verified: true`  
4. 不要提交 `.DS_Store`、`.sitebuilder/`、密钥、本机绝对路径  

## PR 建议

- 小而清晰的改动；说明动机与测试方式  
- 若改 Drop API 调用，注明验证步骤（`previewUrl` 可访问）  
- 文档与 `SKILL.md` 中英文触发词保持同步  

## 行为准则

请保持善意与建设性讨论。恶意上传、滥用临时预览、或提交恶意代码的 PR 将被拒绝。
