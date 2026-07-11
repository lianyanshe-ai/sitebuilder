#!/usr/bin/env node
/**
 * package-static.mjs
 * Resolve & validate static deploy targets for multiple input shapes:
 *
 *  A) 单个 .html 文件
 *  B) 静态资源文件夹（含 index.html / 多文件）
 *  C) 前端工程项目（Vite/React/Next 等 → dist/build/out）
 *
 * Usage:
 *   node package-static.mjs [path] [--zip] [--out path.zip] [--json]
 *   node package-static.mjs [path] --dir dist --json
 *   node package-static.mjs [path] --build --json   # 工程无产物时尝试 npm/pnpm/yarn build
 *   node package-static.mjs file.html --include-siblings  # 单 HTML 时显式附带同级静态文件（仍有上限）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED_EXT = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".map",
  ".json",
  ".txt",
  ".xml",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".pdf",
  ".webmanifest",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  ".DS_Store",
  "__MACOSX",
  ".sitebuilder",
  ".sitebuilder-staged",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  ".vercel",
  ".output",
]);

/** Build output candidates (relative to project root or package root) */
const CANDIDATE_DIRS = [
  "dist",
  "build",
  "out",
  "public",
  "_site",
  "www",
  "site",
  ".output/public",
  "docs/.vitepress/dist",
  "storybook-static",
  // monorepo / nested app common paths
  "apps/web/dist",
  "apps/web/build",
  "apps/web/out",
  "apps/site/dist",
  "apps/frontend/dist",
  "packages/web/dist",
  "client/dist",
  "client/build",
  "frontend/dist",
  "frontend/build",
  "web/dist",
  "web/build",
  "ui/dist",
  "www/dist",
];

/**
 * Cloudflare Drop UI limits (https://www.cloudflare.com/drop/):
 *  - index.html present
 *  - Max individual file size 25MB
 *  - Total file count < 2000
 *  - Total size less than 100MB
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB per file
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100MB total
const MAX_FILES = 1999; // Total file count < 2000

/** Shared constraint summary for CLI JSON / agent messages */
export const DROP_CONSTRAINTS = {
  indexHtmlRequired: true,
  maxIndividualFileMB: 25,
  maxFileCount: 1999, // Drop: total file count < 2000
  maxTotalSizeMB: 100, // Drop: total size less than 100MB
  staticOnly: true,
  unclaimedTtl: "~1 hour",
  claimRequiredForPermanent: true,
  accountRequiredForTempPreview: false,
  source: "https://www.cloudflare.com/drop/",
};

function parseArgs(argv) {
  const args = {
    projectDir: process.cwd(),
    zip: false,
    out: null,
    json: false,
    dir: null,
    build: false,
    includeSiblings: false,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--zip") args.zip = true;
    else if (a === "--json") args.json = true;
    else if (a === "--build") args.build = true;
    else if (a === "--include-siblings") args.includeSiblings = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos[0]) args.projectDir = path.resolve(pos[0]);
  return args;
}

function existsDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function hasIndex(dir) {
  return (
    existsFile(path.join(dir, "index.html")) ||
    existsFile(path.join(dir, "index.htm"))
  );
}

function isHtmlFile(p) {
  try {
    return fs.statSync(p).isFile() && /\.html?$/i.test(p);
  } catch {
    return false;
  }
}

function listTopHtml(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.html?$/i.test(n) && existsFile(path.join(dir, n)))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function readPkg(dir) {
  const p = path.join(dir, "package.json");
  if (!existsFile(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function detectFramework(pkg) {
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const keys = Object.keys(deps || {});
  if (keys.some((k) => k === "next" || k.startsWith("next/"))) return "next";
  if (keys.some((k) => k === "nuxt" || k.startsWith("nuxt"))) return "nuxt";
  if (keys.some((k) => k === "vite" || k.startsWith("@vitejs/"))) return "vite";
  if (keys.some((k) => k === "react-scripts")) return "cra";
  if (keys.some((k) => k === "vue" && keys.includes("@vue/cli-service"))) return "vue-cli";
  if (keys.some((k) => k === "astro")) return "astro";
  if (keys.some((k) => k === "gatsby")) return "gatsby";
  if (keys.some((k) => k === "remix" || k === "@remix-run/dev")) return "remix";
  if (keys.some((k) => k === "svelte" || k === "@sveltejs/kit")) return "sveltekit";
  if (pkg.scripts?.build) return "node-build";
  return null;
}

function isProjectRoot(dir) {
  return (
    existsFile(path.join(dir, "package.json")) ||
    existsFile(path.join(dir, "pnpm-workspace.yaml")) ||
    existsFile(path.join(dir, "lerna.json")) ||
    existsFile(path.join(dir, "turbo.json")) ||
    existsFile(path.join(dir, "nx.json")) ||
    existsFile(path.join(dir, "vite.config.js")) ||
    existsFile(path.join(dir, "vite.config.ts")) ||
    existsFile(path.join(dir, "vite.config.mjs")) ||
    existsFile(path.join(dir, "next.config.js")) ||
    existsFile(path.join(dir, "next.config.mjs")) ||
    existsFile(path.join(dir, "next.config.ts")) ||
    existsFile(path.join(dir, "astro.config.mjs")) ||
    existsFile(path.join(dir, "nuxt.config.ts")) ||
    existsFile(path.join(dir, "nuxt.config.js")) ||
    existsFile(path.join(dir, "angular.json")) ||
    existsFile(path.join(dir, "svelte.config.js"))
  );
}

function isStaticFolder(dir) {
  // Looks like a static site folder (not a full JS monorepo dump)
  if (hasIndex(dir)) return true;
  const htmls = listTopHtml(dir);
  if (htmls.length >= 1) return true;
  // folder of assets only is weak signal
  return false;
}

function countFilesShallow(dir, limit = 50) {
  let n = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      if (SKIP_DIRS.has(name)) continue;
      n++;
      if (n >= limit) break;
    }
  } catch {
    /* ignore */
  }
  return n;
}

/**
 * Stage a single .html (+ optional sibling asset dirs) as deployable root with index.html.
 */
/** Junk-folder signals — never bulk-treat as site asset root */
const JUNK_DIR_NAMES = new Set([
  "downloads",
  "download",
  "desktop",
  "documents",
  "movies",
  "music",
  "pictures",
  "library",
  "applications",
  "trash",
  ".trash",
]);

const ASSET_EXT_RE =
  /\.(css|js|mjs|cjs|map|json|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|pdf|txt|xml|webmanifest)$/i;

/**
 * Extract local relative asset refs from HTML (skip http(s)/data/#/…).
 */
function looksLikeLocalAssetPath(p) {
  if (!p || p.endsWith("/")) return false;
  // Google Fonts axis junk: wght@400;500
  if (/wght@|ital,wght@|;8\.\.|;0,|;1,/i.test(p)) return false;
  if (/[;@]/.test(p) && !ASSET_EXT_RE.test(p)) return false;
  // Prefer paths with a static extension (or explicit relative file)
  if (ASSET_EXT_RE.test(p)) return true;
  // extensionless relative modules rare in static HTML — skip
  return false;
}

export function extractLocalRefs(htmlText) {
  const refs = new Set();
  const patterns = [
    /\bsrc\s*=\s*["']([^"']+)["']/gi,
    /\bhref\s*=\s*["']([^"']+)["']/gi,
    /\bposter\s*=\s*["']([^"']+)["']/gi,
    /\bdata-src\s*=\s*["']([^"']+)["']/gi,
    /\bsrcset\s*=\s*["']([^"']+)["']/gi,
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(htmlText))) {
      const raw = m[1].trim();
      // skip full remote URLs early (including fonts.googleapis.com?family=...:wght@)
      if (/^(https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(raw)) continue;
      const parts = raw.split(",").map((s) => s.trim().split(/\s+/)[0]);
      for (let p of parts) {
        if (!p) continue;
        if (/^(https?:|data:|blob:|mailto:|tel:|javascript:|#|\/\/)/i.test(p)) continue;
        p = p.split("?")[0].split("#")[0];
        if (!looksLikeLocalAssetPath(p)) continue;
        refs.add(p);
      }
    }
  }
  return [...refs];
}

function isJunkParentDir(dir) {
  const base = path.basename(dir).toLowerCase();
  if (JUNK_DIR_NAMES.has(base)) return true;
  return dir
    .split(path.sep)
    .map((s) => s.toLowerCase())
    .some((s) => JUNK_DIR_NAMES.has(s));
}

function copyFileToStaging(srcAbs, stagingRoot, relPosix) {
  const dest = path.join(stagingRoot, ...relPosix.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcAbs, dest);
  return relPosix;
}

/**
 * Stage a single .html as index.html.
 *
 * Strict resource policy (fixes Downloads dump):
 *  1. HTML → index.html
 *  2. Only local paths referenced in HTML (src/href/url/srcset)
 *  3. Name-matched sidecars: foo_files/ foo.files/ next to foo.html
 *  4. NEVER bulk-copy entire parent directory
 *  5. --include-siblings opt-in only (capped; refused for junk parents)
 *
 * @param {string} htmlPath
 * @param {string} [projectHint]
 * @param {{ includeSiblings?: boolean }} [opts]
 */
export function stageSingleHtml(htmlPath, projectHint, opts = {}) {
  const includeSiblings = !!opts.includeSiblings;
  const abs = path.resolve(htmlPath);
  if (!isHtmlFile(abs)) throw new Error(`Not an HTML file: ${abs}`);

  const stamp = Date.now().toString(36);
  const safe = path
    .basename(abs, path.extname(abs))
    .replace(/[^\w\u4e00-\u9fff-]+/g, "_")
    .slice(0, 40);
  const parent = path.dirname(abs);
  const root =
    projectHint && existsDir(projectHint)
      ? path.join(projectHint, ".sitebuilder", "staged", `${safe}-${stamp}`)
      : path.join(parent, ".sitebuilder-staged", `${safe}-${stamp}`);
  fs.mkdirSync(root, { recursive: true });

  const htmlText = fs.readFileSync(abs, "utf8");
  fs.writeFileSync(path.join(root, "index.html"), htmlText);

  const copied = [];
  const missing = [];
  const junkParent = isJunkParentDir(parent);

  // 1) HTML-referenced local assets only
  for (const ref of extractLocalRefs(htmlText)) {
    const srcAbs = path.resolve(parent, ref);
    const parentPrefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
    if (!srcAbs.startsWith(parentPrefix) && srcAbs !== parent) continue;
    if (!existsFile(srcAbs)) {
      missing.push(ref);
      continue;
    }
    const rel = path.relative(parent, srcAbs).split(path.sep).join("/");
    copyFileToStaging(srcAbs, root, rel);
    copied.push(rel);
  }

  // 2) Name-matched sidecars only (not generic assets/css/js — those explode in Downloads)
  const base = path.basename(abs, path.extname(abs));
  const sidecarNames = [`${base}_files`, `${base}.files`, `${base}-files`];
  // bare `base/` only when parent is a real project-ish dir
  if (!junkParent) sidecarNames.push(base);

  for (const name of sidecarNames) {
    const src = path.join(parent, name);
    if (!existsDir(src)) continue;
    try {
      fs.cpSync(src, path.join(root, name), {
        recursive: true,
        filter: (p) => {
          const bn = path.basename(p);
          if (SKIP_DIRS.has(bn)) return false;
          if (bn === ".sitebuilder" || bn === ".sitebuilder-staged") return false;
          return true;
        },
      });
      copied.push(name + "/");
    } catch {
      /* skip */
    }
  }

  // 3) Opt-in siblings (never default; never for junk parents)
  let siblingNote = "";
  if (includeSiblings && !junkParent) {
    const MAX_N = 30;
    const MAX_B = 5 * 1024 * 1024;
    let n = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(parent)) {
        if (!ASSET_EXT_RE.test(name)) continue;
        const src = path.join(parent, name);
        if (!existsFile(src) || copied.includes(name)) continue;
        const sz = fs.statSync(src).size;
        if (n >= MAX_N || bytes + sz > MAX_B) {
          siblingNote = `（--include-siblings 已截断：≤${MAX_N} 文件 / 5MB）`;
          break;
        }
        fs.copyFileSync(src, path.join(root, name));
        copied.push(name);
        n++;
        bytes += sz;
      }
    } catch {
      /* ignore */
    }
  } else if (includeSiblings && junkParent) {
    siblingNote =
      "（已忽略 --include-siblings：父目录像 Downloads/Desktop，拒绝整夹附带）";
  }

  const uniqueCopied = [...new Set(copied)];
  let note = `单文件 HTML 已暂存为 index.html（原名: ${path.basename(abs)}）`;
  if (uniqueCopied.length) {
    note += `；按 HTML 引用/侧车目录附带 ${uniqueCopied.length} 项: ${uniqueCopied
      .slice(0, 10)
      .join(", ")}`;
  } else {
    note += junkParent
      ? "；父目录为杂货目录，未附带同级无关文件（仅 HTML + 文内引用）"
      : "；未发现本地引用资源（纯内联/外链 HTML）";
  }
  if (missing.length) {
    note += `；缺失引用: ${missing.slice(0, 3).join(", ")}`;
  }
  note += siblingNote;

  return {
    buildDir: root,
    stagedFrom: abs,
    note,
    copied: uniqueCopied,
    missing,
  };
}

/**
 * Stage a static folder that has HTML but no index.html.
 * Uses the largest HTML as homepage (common for export folders).
 */
function stageFolderWithHtml(dir) {
  const htmls = listTopHtml(dir);
  if (!htmls.length) return null;
  // Prefer names that look like entry
  const ranked = htmls
    .map((p) => {
      const n = path.basename(p).toLowerCase();
      let score = fs.statSync(p).size;
      if (/^(index|home|main|default)\.html?$/.test(n)) score += 1e12;
      if (/landing|home|index/.test(n)) score += 1e9;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);

  // If already has real index, no stage
  if (hasIndex(dir)) {
    return { buildDir: dir, note: null, scenario: "static-folder" };
  }

  // Folder already is the site root with multiple pages — rewrite only if single non-index html
  if (htmls.length === 1) {
    // Folder with exactly one HTML: treat as mini-site root of that folder,
    // NOT parent of a file in Downloads — stage from HTML with ref scan only.
    const staged = stageSingleHtml(htmls[0], dir, { includeSiblings: false });
    return {
      buildDir: staged.buildDir,
      stagedFrom: staged.stagedFrom,
      note: staged.note,
      scenario: "static-folder-single-html",
    };
  }

  // Multiple HTML pages without index: copy entire folder + add index redirect/copy from best entry
  const stamp = Date.now().toString(36);
  const root = path.join(dir, ".sitebuilder", "staged", `folder-${stamp}`);
  fs.mkdirSync(root, { recursive: true });
  fs.cpSync(dir, root, {
    recursive: true,
    filter: (p) => {
      const bn = path.basename(p);
      if (bn === ".sitebuilder" || bn === ".sitebuilder-staged") return false;
      if (SKIP_DIRS.has(bn) && bn !== "public") return false;
      return true;
    },
  });
  const entry = ranked[0].p;
  fs.copyFileSync(entry, path.join(root, "index.html"));
  return {
    buildDir: root,
    stagedFrom: entry,
    note: `静态文件夹无 index.html，已用「${path.basename(entry)}」作为首页（同目录另有 ${htmls.length - 1} 个 HTML）`,
    scenario: "static-folder-multi-html",
  };
}

function findBuildOutput(projectDir) {
  for (const rel of CANDIDATE_DIRS) {
    const d = path.join(projectDir, rel);
    if (existsDir(d) && hasIndex(d)) {
      return { buildDir: d, rel, hasIndex: true };
    }
  }
  // candidates without index (last resort)
  for (const rel of CANDIDATE_DIRS) {
    const d = path.join(projectDir, rel);
    if (existsDir(d) && countFilesShallow(d) > 0) {
      return { buildDir: d, rel, hasIndex: false };
    }
  }
  return null;
}

function detectPackageManager(dir) {
  if (existsFile(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsFile(path.join(dir, "yarn.lock"))) return "yarn";
  if (existsFile(path.join(dir, "bun.lockb")) || existsFile(path.join(dir, "bun.lock")))
    return "bun";
  return "npm";
}

/**
 * Try to build a frontend project. Returns { ok, log, buildDir? }
 */
export function tryProjectBuild(projectDir, { onProgress } = {}) {
  const pkg = readPkg(projectDir);
  if (!pkg?.scripts?.build && !pkg?.scripts?.["build:static"] && !pkg?.scripts?.export) {
    return {
      ok: false,
      log: "package.json 无 build / build:static / export 脚本",
    };
  }
  const pm = detectPackageManager(projectDir);
  const script = pkg.scripts["build:static"]
    ? "build:static"
    : pkg.scripts.export
      ? "export"
      : "build";

  onProgress?.(`build via ${pm} run ${script}`);
  const cmd =
    pm === "npm"
      ? ["npm", ["run", script]]
      : pm === "pnpm"
        ? ["pnpm", ["run", script]]
        : pm === "yarn"
          ? ["yarn", [script]]
          : ["bun", ["run", script]];

  const r = spawnSync(cmd[0], cmd[1], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
    timeout: 600000,
  });
  const log = `${r.stdout || ""}\n${r.stderr || ""}`.slice(-4000);
  if (r.status !== 0) {
    return { ok: false, log: `build failed (exit ${r.status})\n${log}` };
  }
  const out = findBuildOutput(projectDir);
  if (!out?.hasIndex) {
    return {
      ok: false,
      log:
        `build 结束但未找到带 index.html 的产物目录（dist/build/out…）\n` +
        `Next.js 需 static export；请检查 next.config 的 output: 'export'。\n${log.slice(-800)}`,
    };
  }
  return { ok: true, log, buildDir: out.buildDir, rel: out.rel };
}

/**
 * Classify input path into a deploy scenario.
 * @returns {'html-file'|'static-folder'|'project'|'unknown'}
 */
export function classifyInput(input) {
  const abs = path.resolve(input || process.cwd());
  if (isHtmlFile(abs)) return "html-file";
  if (!existsDir(abs)) return "unknown";
  if (isProjectRoot(abs) || readPkg(abs)) return "project";
  if (isStaticFolder(abs)) return "static-folder";
  // nested: directory that only contains a project subfolder
  try {
    const kids = fs.readdirSync(abs).filter((n) => !n.startsWith("."));
    for (const k of kids) {
      const p = path.join(abs, k);
      if (existsDir(p) && isProjectRoot(p)) return "project";
    }
  } catch {
    /* ignore */
  }
  return "static-folder"; // treat as static attempt
}

/**
 * Resolve what to deploy from:
 *  - single .html file
 *  - static folder
 *  - frontend project (with optional --build)
 *
 * @returns {object}
 */
export function resolveDeployTarget(
  input,
  explicitDir,
  { build = false, includeSiblings = false, onProgress } = {}
) {
  const abs = path.resolve(input || process.cwd());
  const scenario = classifyInput(abs);
  const stageOpts = { includeSiblings };

  // ---------- A) single HTML file ----------
  if (isHtmlFile(abs)) {
    const staged = stageSingleHtml(abs, path.dirname(abs), stageOpts);
    return {
      scenario: "html-file",
      projectDir: path.dirname(abs),
      buildDir: staged.buildDir,
      stagedFrom: staged.stagedFrom,
      note: staged.note,
      framework: null,
    };
  }

  if (!existsDir(abs)) {
    throw new Error(
      `路径不存在: ${abs}\n` +
        `支持三种输入：\n` +
        `  A) 单个 .html 文件\n` +
        `  B) 静态文件夹（含 index.html 或网页资源）\n` +
        `  C) 前端工程目录（含 package.json，产物在 dist/build/out）`
    );
  }

  // ---------- explicit --dir ----------
  if (explicitDir) {
    const d = path.isAbsolute(explicitDir)
      ? explicitDir
      : path.resolve(abs, explicitDir);
    if (isHtmlFile(d)) {
      const staged = stageSingleHtml(d, abs, stageOpts);
      return {
        scenario: "html-file",
        projectDir: abs,
        buildDir: staged.buildDir,
        stagedFrom: staged.stagedFrom,
        note: staged.note,
        framework: null,
      };
    }
    if (!existsDir(d)) throw new Error(`指定目录不存在: ${d}`);
    if (!hasIndex(d)) {
      const staged = stageFolderWithHtml(d);
      if (staged) {
        return {
          scenario: staged.scenario || "static-folder",
          projectDir: abs,
          buildDir: staged.buildDir,
          stagedFrom: staged.stagedFrom,
          note: staged.note,
          framework: null,
        };
      }
      throw new Error(`指定目录无 index.html 且无可用 HTML: ${d}`);
    }
    return {
      scenario: isProjectRoot(abs) ? "project" : "static-folder",
      projectDir: abs,
      buildDir: d,
      note: `使用指定产物目录: ${path.relative(abs, d) || d}`,
      framework: detectFramework(readPkg(abs)),
    };
  }

  // ---------- C) frontend project ----------
  if (isProjectRoot(abs) || readPkg(abs)) {
    const pkg = readPkg(abs);
    const framework = detectFramework(pkg);
    let out = findBuildOutput(abs);

    if ((!out || !out.hasIndex) && build) {
      onProgress?.("project has no dist; running build…");
      const built = tryProjectBuild(abs, { onProgress });
      if (!built.ok) {
        throw new Error(
          `工程项目需要先构建静态产物，自动 build 失败：\n${built.log}\n` +
            `请手动执行 npm/pnpm/yarn build 后重试，或用 --dir 指定产物目录。`
        );
      }
      out = { buildDir: built.buildDir, rel: built.rel, hasIndex: true };
    }

    if (out?.hasIndex) {
      return {
        scenario: "project",
        projectDir: abs,
        buildDir: out.buildDir,
        note: `工程项目产物: ${out.rel || path.relative(abs, out.buildDir)}${framework ? ` (${framework})` : ""}`,
        framework,
      };
    }

    // project but only root public/ with html?
    if (hasIndex(abs) && !existsFile(path.join(abs, "package.json"))) {
      /* fall through */
    } else if (hasIndex(path.join(abs, "public"))) {
      return {
        scenario: "project",
        projectDir: abs,
        buildDir: path.join(abs, "public"),
        note: "使用 public/ 作为静态产物（未检测到 dist/build；如为 Vite 源码站请先 build）",
        framework,
        warnings: [
          "工程目录未找到 dist/build/out。若这是源码项目，请先 build 或加 --build。当前使用 public/。",
        ],
      };
    } else {
      throw new Error(
        `检测到前端工程（${framework || "node"}），但没有可部署的静态产物。\n` +
          `请任选其一：\n` +
          `  1) 在项目内执行 build（npm run build）后再部署\n` +
          `  2) 部署时加 --build 让 sitebuilder 自动构建\n` +
          `  3) 用 --dir dist 指定产物目录\n` +
          `常见产物: dist/  build/  out/  apps/web/dist/`
      );
    }
  }

  // ---------- B) static folder ----------
  if (hasIndex(abs)) {
    // Guard: accidentally pointing at huge home folders
    const shallow = countFilesShallow(abs, 80);
    if (shallow >= 80 && !existsFile(path.join(abs, "index.html"))) {
      // still has index via index.htm
    }
    return {
      scenario: "static-folder",
      projectDir: abs,
      buildDir: abs,
      note: "静态文件夹（根目录 index.html）",
      framework: null,
    };
  }

  // subdir candidates inside a "folder of stuff"
  const sub = findBuildOutput(abs);
  if (sub?.hasIndex) {
    return {
      scenario: "static-folder",
      projectDir: abs,
      buildDir: sub.buildDir,
      note: `静态文件夹内产物: ${sub.rel}`,
      framework: null,
    };
  }

  // nested project: ./my-app/package.json
  try {
    for (const name of fs.readdirSync(abs)) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const p = path.join(abs, name);
      if (!existsDir(p) || !isProjectRoot(p)) continue;
      const nested = resolveDeployTarget(p, null, { build, onProgress });
      return {
        ...nested,
        projectDir: abs,
        note: `在子目录 ${name}/ 发现工程并解析：${nested.note || nested.buildDir}`,
      };
    }
  } catch {
    /* ignore */
  }

  const staged = stageFolderWithHtml(abs);
  if (staged) {
    return {
      scenario: staged.scenario || "static-folder",
      projectDir: abs,
      buildDir: staged.buildDir,
      stagedFrom: staged.stagedFrom,
      note: staged.note,
      framework: null,
    };
  }

  throw new Error(
    `无法从路径解析可部署静态站: ${abs}\n` +
      `已识别类型: ${scenario}\n` +
      `请确认：\n` +
      `  A) 单 HTML：直接传 .html 文件路径\n` +
      `  B) 静态夹：目录内有 index.html（或仅一个 html）\n` +
      `  C) 工程：有 package.json 且已 build 出 dist/（或加 --build）`
  );
}

// Back-compat alias
export function findBuildDir(projectDir, explicit) {
  return resolveDeployTarget(projectDir, explicit).buildDir;
}

function walk(dir, base = dir, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (name === ".DS_Store" || name.startsWith("._")) continue;
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, base, files);
    else if (st.isFile()) {
      files.push({
        abs: full,
        rel: path.relative(base, full).split(path.sep).join("/"),
        size: st.size,
        ext: path.extname(name).toLowerCase(),
      });
    }
  }
  return files;
}

export function analyzeBuildDir(buildDir) {
  const files = walk(buildDir);
  if (files.length === 0) throw new Error(`Build directory is empty: ${buildDir}`);

  // Drop: Total file count < 2000
  if (files.length > MAX_FILES) {
    throw new Error(
      `Too many files (${files.length}). Cloudflare Drop requires total file count < 2000 ` +
        `(max ${MAX_FILES}). 请只部署 dist/ 产物，不要整包源码或 Downloads。`
    );
  }

  // Drop: Max individual file size 25MB
  const oversized = files
    .filter((f) => f.size > MAX_FILE_BYTES)
    .sort((a, b) => b.size - a.size);
  if (oversized.length) {
    const list = oversized
      .slice(0, 5)
      .map((f) => `${f.rel} (${(f.size / 1024 / 1024).toFixed(1)}MB)`)
      .join(", ");
    throw new Error(
      `File(s) exceed Cloudflare Drop max individual size 25MB: ${list}` +
        (oversized.length > 5 ? ` …(+${oversized.length - 5} more)` : "") +
        `。请压缩或拆分大文件后再部署。`
    );
  }

  // Drop: Total size less than 100MB
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  if (totalSize > MAX_TOTAL_BYTES) {
    throw new Error(
      `Total size ${(totalSize / 1024 / 1024).toFixed(1)}MB exceeds Cloudflare Drop limit ` +
        `(total size < 100MB)。请勿把 Downloads 等大目录整包上传。`
    );
  }

  // Drop: index.html present (required at site root)
  const hasIndex = files.some(
    (f) => f.rel === "index.html" || f.rel === "index.htm"
  );
  if (!hasIndex) {
    throw new Error(
      "Cloudflare Drop requires index.html at the site root. " +
        "单 HTML 请用 deploy 自动暂存；多页站点请保证入口为 index.html。"
    );
  }

  const nonStatic = files.filter((f) => !ALLOWED_EXT.has(f.ext) && f.ext !== "");
  const warnings = [];
  if (nonStatic.length) {
    warnings.push(
      `${nonStatic.length} non-typical static file(s) (e.g. ${nonStatic
        .slice(0, 5)
        .map((f) => f.rel)
        .join(", ")}). Drop supports HTML/CSS/JS/images/fonts.`
    );
  }
  // refuse obvious source trees
  const sourceish = files.filter((f) =>
    /\.(tsx?|jsx?|vue|svelte|scss|less|php|py|rb|go|java|cs|aspx?)$/i.test(f.rel)
  );
  // allow .js which is both source and built; block .ts/.tsx/.vue etc.
  const blocked = sourceish.filter((f) => !/\.m?jsx?$/i.test(f.rel));
  if (blocked.length > 5) {
    throw new Error(
      `检测到大量源码文件（${blocked
        .slice(0, 5)
        .map((f) => f.rel)
        .join(", ")}…）。请部署构建产物 dist/，不要部署整个源码工程。`
    );
  }
  const serverish = files.filter((f) =>
    /\.(php|py|rb|go|java|cs|aspx?)$/i.test(f.rel)
  );
  if (serverish.length) {
    throw new Error(
      `Server-side files detected (not static-only): ${serverish
        .slice(0, 5)
        .map((f) => f.rel)
        .join(", ")}`
    );
  }

  const maxFile = files.reduce(
    (m, f) => (f.size > m.size ? f : m),
    files[0]
  );

  return {
    buildDir,
    fileCount: files.length,
    totalSize,
    totalSizeMB: +(totalSize / 1024 / 1024).toFixed(3),
    maxFileBytes: maxFile.size,
    maxFileMB: +(maxFile.size / 1024 / 1024).toFixed(3),
    maxFilePath: maxFile.rel,
    hasIndex: true,
    withinDropLimits: true,
    warnings,
    files,
  };
}

export function createZip(buildDir, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  try {
    execFileSync("zip", ["-r", "-q", outPath, "."], {
      cwd: buildDir,
      stdio: "pipe",
    });
  } catch {
    try {
      execFileSync(
        "ditto",
        ["-c", "-k", "--sequesterRsrc", "--keepParent", buildDir, outPath],
        { stdio: "pipe" }
      );
    } catch (e) {
      throw new Error(`Failed to create zip. Install zip CLI. Original: ${e.message}`);
    }
  }
  const st = fs.statSync(outPath);
  return { zipPath: outPath, zipSize: st.size };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveDeployTarget(args.projectDir, args.dir, {
    build: args.build,
    includeSiblings: args.includeSiblings,
    onProgress: args.json ? undefined : (m) => console.error(`[resolve] ${m}`),
  });
  const analysis = analyzeBuildDir(target.buildDir);
  const warnings = [
    ...(analysis.warnings || []),
    ...(target.warnings || []),
    ...(target.note ? [target.note] : []),
  ];

  let zip = null;
  if (args.zip) {
    const out =
      args.out ||
      path.join(target.projectDir, `.sitebuilder`, `deploy-${Date.now()}.zip`);
    zip = createZip(target.buildDir, out);
  }

  const result = {
    ok: true,
    scenario: target.scenario,
    projectDir: target.projectDir,
    buildDir: analysis.buildDir,
    stagedFrom: target.stagedFrom || null,
    framework: target.framework || null,
    fileCount: analysis.fileCount,
    totalSizeMB: analysis.totalSizeMB,
    maxFileMB: analysis.maxFileMB,
    maxFilePath: analysis.maxFilePath,
    hasIndex: analysis.hasIndex,
    withinDropLimits: analysis.withinDropLimits,
    warnings,
    zipPath: zip?.zipPath ?? null,
    zipSize: zip?.zipSize ?? null,
    constraints: { ...DROP_CONSTRAINTS },
  };

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Scenario: ${result.scenario}`);
    console.log(`Build dir: ${result.buildDir}`);
    console.log(`Files: ${result.fileCount} / <2000 (${result.totalSizeMB} MB / <100MB)`);
    console.log(
      `Largest file: ${result.maxFilePath} (${result.maxFileMB} MB / ≤25MB)`
    );
    console.log(`index.html: ${result.hasIndex ? "yes" : "NO"}`);
    console.log(`Drop limits: ${result.withinDropLimits ? "OK" : "FAIL"}`);
    if (result.framework) console.log(`Framework: ${result.framework}`);
    for (const w of warnings) console.log(`WARN: ${w}`);
    if (result.zipPath) console.log(`Zip: ${result.zipPath}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}
