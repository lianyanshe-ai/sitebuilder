#!/usr/bin/env node
/**
 * match-style.mjs — Auto-match best DESIGN.md style for a site brief.
 *
 * Usage:
 *   node match-style.mjs "加密货币交易仪表盘" [--top 5] [--json]
 *   node match-style.mjs --brief "SaaS landing for AI coding tool, dark, developer" --top 3
 *   node match-style.mjs --file ./README.md
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, "..", "references", "styles-catalog.json");

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s.+#-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

/** Lightweight bilingual keyword boost map */
const KEYWORD_BOOSTS = [
  { re: /加密|crypto|web3|defi|trading|交易所|合约|btc|bitcoin/i, styles: ["binance", "kraken", "coinbase"] },
  { re: /支付|payment|stripe|checkout|billing/i, styles: ["stripe", "wise", "mastercard"] },
  { re: /银行|fintech|banking|wallet|钱包/i, styles: ["revolut", "wise", "coinbase"] },
  { re: /ai\s*agent|agent\s*framework|多智能体/i, styles: ["voltagent", "cursor", "claude"] },
  { re: /\bai\b|llm|chatbot|助手|大模型|gpt/i, styles: ["claude", "cursor", "x.ai", "mistral.ai", "ollama"] },
  { re: /code|coding|ide|developer|开发者|程序员|github/i, styles: ["cursor", "vercel", "linear.app", "warp"] },
  { re: /design|figma|创意|设计工具|prototype/i, styles: ["figma", "framer", "clay", "webflow"] },
  { re: /docs|documentation|文档|知识库/i, styles: ["mintlify", "notion", "hashicorp"] },
  { re: /music|音乐|spotify|播客/i, styles: ["spotify"] },
  { re: /电商|ecommerce|shop|commerce|店铺/i, styles: ["shopify", "nike", "airbnb"] },
  { re: /travel|旅游|hotel|booking|民宿/i, styles: ["airbnb"] },
  { re: /automotive|汽车|ev|电动车|tesla|tsla/i, styles: ["tesla", "bmw", "ferrari"] },
  { re: /minimal|极简|黑白|monochrome|stark/i, styles: ["vercel", "tesla", "x.ai", "spacex", "linear.app"] },
  { re: /dark|暗色|深色|cyber/i, styles: ["binance", "cursor", "supabase", "raycast", "minimax"] },
  { re: /warm|温暖|友好|friendly|soft/i, styles: ["claude", "notion", "airbnb", "zapier"] },
  { re: /enterprise|企业|b2b|carbon/i, styles: ["ibm", "hashicorp", "cohere"] },
  { re: /retro|怀旧|90s|y2k|复古/i, styles: ["dell-1996", "nintendo-2001"] },
  { re: /magazine|媒体|editorial|杂志|news/i, styles: ["theverge", "wired", "runwayml"] },
  { re: /database|数据库|backend|baas/i, styles: ["supabase", "mongodb", "clickhouse"] },
  { re: /analytics|监控|sentry|observability/i, styles: ["posthog", "sentry"] },
  { re: /voice|语音|audio|tts/i, styles: ["elevenlabs"] },
  { re: /video|视频|film|cinematic/i, styles: ["runwayml", "elevenlabs", "apple"] },
  { re: /schedule|calendar|预约|日历/i, styles: ["cal"] },
  { re: /email|邮件/i, styles: ["resend", "superhuman"] },
  { re: /automation|自动化|zapier|集成/i, styles: ["zapier", "composio"] },
  { re: /premium|luxury|奢华|高端|旗舰/i, styles: ["apple", "bugatti", "lamborghini", "ferrari"] },
  { re: /landing|营销|marketing|saas/i, styles: ["stripe", "vercel", "linear.app", "framer"] },
  { re: /game|游戏|console|playstation/i, styles: ["playstation", "nintendo-2001"] },
  { re: /coffee|咖啡|retail|餐饮/i, styles: ["starbucks"] },
  { re: /space|航天|火箭|spacex/i, styles: ["spacex", "x.ai"] },
];

export function matchStyles(brief, { top = 5, catalog = loadCatalog() } = {}) {
  const text = String(brief);
  const tokens = new Set(tokenize(text));
  const scores = new Map();

  for (const style of catalog.styles) {
    let score = 0;
    const reasons = [];

    // tag / id / name token overlap
    const bag = [
      style.id,
      style.name.toLowerCase(),
      style.category,
      style.vibe,
      ...(style.tags || []),
      ...(style.bestFor || []),
    ]
      .join(" ")
      .toLowerCase();

    for (const t of tokens) {
      if (bag.includes(t)) {
        score += t.length > 4 ? 3 : 2;
        reasons.push(`token:${t}`);
      }
    }

    // keyword boosts
    for (const b of KEYWORD_BOOSTS) {
      if (b.re.test(text) && b.styles.includes(style.id)) {
        score += 12;
        reasons.push(`boost:${b.re.source.slice(0, 24)}`);
      }
    }

    // exact style mention
    if (new RegExp(`\\b${style.id.replace(".", "\\.")}\\b`, "i").test(text)) {
      score += 50;
      reasons.push("exact-id");
    }
    if (text.toLowerCase().includes(style.name.toLowerCase())) {
      score += 40;
      reasons.push("exact-name");
    }

    // alias mention
    for (const [alias, id] of Object.entries(catalog.aliases)) {
      if (id === style.id && text.toLowerCase().includes(alias)) {
        score += 45;
        reasons.push(`alias:${alias}`);
      }
    }

    if (score > 0) scores.set(style.id, { score, reasons, style });
  }

  const ranked = [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, top);

  // fallback defaults if nothing matched
  if (ranked.length === 0) {
    const fallbacks = ["vercel", "linear.app", "stripe", "claude", "figma"];
    for (const id of fallbacks.slice(0, top)) {
      const style = catalog.styles.find((s) => s.id === id);
      if (style) {
        ranked.push({
          score: 1,
          reasons: ["default-fallback"],
          style,
        });
      }
    }
  }

  return {
    brief: text.slice(0, 500),
    matches: ranked.map((r, i) => ({
      rank: i + 1,
      id: r.style.id,
      name: r.style.name,
      score: r.score,
      category: r.style.category,
      vibe: r.style.vibe,
      bestFor: r.style.bestFor,
      palette: r.style.palette,
      reasons: [...new Set(r.reasons)].slice(0, 8),
    })),
    recommended: ranked[0]?.style.id || "vercel",
  };
}

function parseArgs(argv) {
  const args = { brief: null, top: 5, json: false, file: null };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--top") args.top = parseInt(argv[++i], 10) || 5;
    else if (a === "--brief") args.brief = argv[++i];
    else if (a === "--file") args.file = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos.length) args.brief = pos.join(" ");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let brief = args.brief;
  if (args.file) {
    brief = fs.readFileSync(path.resolve(args.file), "utf8");
  }
  if (!brief) {
    throw new Error(
      'Usage: match-style.mjs "brief text" [--top 5] [--json]\n' +
        "       match-style.mjs --file README.md"
    );
  }

  const result = matchStyles(brief, { top: args.top });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Recommended: ${result.recommended}\n`);
    for (const m of result.matches) {
      console.log(
        `${m.rank}. ${m.id} (${m.name})  score=${m.score}\n   ${m.vibe}\n   bestFor: ${(m.bestFor || []).join(", ")}`
      );
    }
    console.log(
      `\nNext: node fetch-style.mjs ${result.recommended} --project <dir>`
    );
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
