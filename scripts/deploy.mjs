#!/usr/bin/env node
/**
 * deploy.mjs — One-click deploy static build via Cloudflare Drop.
 *
 * Methods (priority):
 *   drop (default)  — Drop provisioning API (same as https://www.cloudflare.com/drop)
 *                     No user API token. Fast (~15s). Returns preview + claim URL.
 *   drop-browser    — Playwright automation of the Drop web UI
 *   temporary       — Fallback: wrangler deploy --temporary (slower, no Drop UI)
 *   zip-only        — Package zip for manual upload to cloudflare.com/drop
 *
 * Inputs (auto-detected):
 *   A) single .html file
 *   B) static folder (index.html / multi-html)
 *   C) frontend project (package.json → dist/build/out; optional --build)
 *
 * Usage:
 *   node deploy.mjs [path] [--method drop|drop-browser|temporary|zip-only]
 *                   [--dir dist] [--build] [--name my-site] [--json] [--open-claim]
 *
 * Output: preview URL + claim URL. Unclaimed ~1 hour. No Cloudflare API key needed.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import {
  resolveDeployTarget,
  analyzeBuildDir,
  createZip,
  DROP_CONSTRAINTS,
} from "./package-static.mjs";
import { deployViaDropApi } from "./drop-api.mjs";

function parseArgs(argv) {
  const args = {
    projectDir: process.cwd(),
    method: "drop", // default: Cloudflare Drop (not wrangler temporary)
    dir: null,
    name: null,
    json: false,
    openClaim: false,
    /** Unset API token so --temporary works even if machine is logged in */
    forceTemporary: false,
    noFallback: false,
    /** For frontend projects: run npm/pnpm/yarn build if no dist */
    build: false,
    /** Single HTML: opt-in to attach same-dir static files (still capped; never for Downloads) */
    includeSiblings: false,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--open-claim") args.openClaim = true;
    else if (a === "--force-temporary") args.forceTemporary = true;
    else if (a === "--no-fallback") args.noFallback = true;
    else if (a === "--build") args.build = true;
    else if (a === "--include-siblings") args.includeSiblings = true;
    else if (a === "--method") args.method = argv[++i];
    else if (a === "--dir") args.dir = argv[++i];
    else if (a === "--name") args.name = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos[0]) args.projectDir = path.resolve(pos[0]);
  return args;
}

function slugify(s) {
  const raw = String(s || "site");
  let ascii = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // 中文等非 ASCII 名：slugify 后可能只剩数字/空，用 hash 生成合法 Worker 名
  if (!ascii || ascii.length < 3 || !/[a-z]/.test(ascii)) {
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = (h * 33) ^ raw.charCodeAt(i);
    const hex = (h >>> 0).toString(16).slice(0, 8);
    const year = (raw.match(/\d{4}/) || [])[0] || "";
    ascii = `page${year ? "-" + year : ""}-${hex}`.slice(0, 40);
  }
  return ascii || "sitebuilder-preview";
}

function ensureWrangler() {
  // Use npx so we always get a recent enough wrangler (>=4.102 for --temporary)
  return { cmd: "npx", argsPrefix: ["--yes", "wrangler@4"] };
}

function writeTempWorkerProject(buildDir, name) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sitebuilder-"));
  const assetsLink = path.join(tmp, "assets");

  // Copy build into assets/ (wrangler assets.directory)
  // Prefer symlink for speed; fall back to copy
  try {
    fs.symlinkSync(buildDir, assetsLink, "dir");
  } catch {
    fs.cpSync(buildDir, assetsLink, { recursive: true });
  }

  const wranglerToml = `name = "${name}"
compatibility_date = "2025-05-19"

[assets]
directory = "./assets"
not_found_handling = "single-page-application"
`;
  fs.writeFileSync(path.join(tmp, "wrangler.toml"), wranglerToml);

  // Minimal package.json so wrangler is happy in the temp dir
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name, private: true }, null, 2)
  );

  return tmp;
}

function parseWranglerOutput(text) {
  const result = {
    previewUrl: null,
    claimUrl: null,
    account: null,
    claimWithin: null,
    raw: text,
  };

  // Preview / workers.dev URL
  const urlPatterns = [
    /https:\/\/[a-z0-9.-]+\.workers\.dev[^\s]*/gi,
    /Deployed\s+\S+\s+triggers[\s\S]*?(https:\/\/[^\s]+)/i,
    /(?:Available at|Preview|URL|Live)[:\s]+(https:\/\/[^\s]+)/i,
  ];
  for (const re of urlPatterns) {
    const m = text.match(re);
    if (m) {
      const u = (m[0].startsWith("http") ? m[0] : m[1])?.replace(/[).,]+$/, "");
      if (u?.includes("workers.dev") || u?.includes("pages.dev")) {
        result.previewUrl = u;
        break;
      }
    }
  }
  // Prefer last workers.dev occurrence (usually the final URL)
  const allWorkers = [...text.matchAll(/https:\/\/[a-z0-9.-]+\.workers\.dev/gi)].map(
    (m) => m[0]
  );
  if (allWorkers.length) result.previewUrl = allWorkers[allWorkers.length - 1];

  // Claim URL
  const claim =
    text.match(/https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s]+/i) ||
    text.match(/Claim URL:\s*(https:\/\/[^\s]+)/i);
  if (claim) {
    result.claimUrl = (claim[1] || claim[0]).replace(/[).,]+$/, "");
  }

  const account = text.match(/Account:\s*(.+)/i);
  if (account) result.account = account[1].trim();

  const within = text.match(/Claim within:\s*(.+)/i);
  if (within) result.claimWithin = within[1].trim();

  return result;
}

function wranglerEnv(forceTemporary) {
  const env = {
    ...process.env,
    CI: "1",
    WRANGLER_SEND_METRICS: "false",
    // Keep default log level so we can parse preview/claim URLs from stdout
  };
  if (forceTemporary) {
    // Temporary preview accounts require unauthenticated wrangler
    for (const k of [
      "CLOUDFLARE_API_TOKEN",
      "CF_API_TOKEN",
      "CLOUDFLARE_API_KEY",
      "CF_API_KEY",
      "CLOUDFLARE_EMAIL",
      "CF_EMAIL",
      "CLOUDFLARE_ACCOUNT_ID",
      "CF_ACCOUNT_ID",
      "CLOUDFLARE_API_BASE_URL",
    ]) {
      delete env[k];
    }
    // Prevent reading cached OAuth from user wrangler config when possible
    env.WRANGLER_HOME = path.join(os.tmpdir(), "sitebuilder-wrangler-home");
    try {
      fs.mkdirSync(env.WRANGLER_HOME, { recursive: true });
    } catch {
      /* ignore */
    }
  }
  return env;
}

function deployTemporary(buildDir, name, { forceTemporary = false } = {}) {
  const tmp = writeTempWorkerProject(buildDir, name);
  const { cmd, argsPrefix } = ensureWrangler();

  const run = (extraArgs, forceTmp) =>
    spawnSync(cmd, [...argsPrefix, "deploy", ...extraArgs], {
      cwd: tmp,
      encoding: "utf8",
      env: wranglerEnv(forceTmp),
      timeout: 300000,
    });

  // Prefer true temporary (Drop-equivalent) when forced or when not authenticated
  let usedTemporary = true;
  let proc = run(["--temporary"], forceTemporary);
  let combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;

  // Already authenticated → either force-temporary by stripping creds, or permanent deploy
  const authBlocked =
    proc.status !== 0 &&
    /already authenticated|can'?t be used|cannot be used/i.test(combined);

  if (authBlocked && !forceTemporary) {
    // Retry once with credentials stripped to get Drop-like 1h preview
    proc = run(["--temporary"], true);
    combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  }

  if (
    proc.status !== 0 &&
    authBlocked &&
    !forceTemporary &&
    /already authenticated/i.test(combined)
  ) {
    // Fall back: permanent deploy on the logged-in account
    usedTemporary = false;
    proc = run([], false);
    combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  }

  // Wrangler may ask to rerun with --temporary when completely unauthenticated
  if (
    proc.status !== 0 &&
    /rerun this command with `--temporary`|use `--temporary`/i.test(combined)
  ) {
    usedTemporary = true;
    proc = run(["--temporary"], true);
    combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
  }

  const parsed = parseWranglerOutput(combined);

  if (proc.status !== 0 && !parsed.previewUrl) {
    const err = new Error(
      `wrangler deploy failed (exit ${proc.status}).\n${combined.slice(-2500)}`
    );
    err.raw = combined;
    throw err;
  }

  const isTemp = usedTemporary && !!parsed.claimUrl;
  const isPermanentAccount = !isTemp && !!parsed.previewUrl;

  return {
    method: isTemp ? "temporary" : isPermanentAccount ? "account" : "temporary",
    workDir: tmp,
    temporary: isTemp,
    permanent: isPermanentAccount,
    ...parsed,
    expiresNote: isTemp
      ? "未认领的临时预览约 60 分钟后失效。打开 claimUrl 登录 Cloudflare 账号即可永久保留。"
      : isPermanentAccount
        ? "已使用本机 Cloudflare 账号部署到 workers.dev（持久保留，无需 Claim）。若只要 1 小时临时预览，请加 --force-temporary。"
        : "未认领的临时预览约 60 分钟后失效。打开 claimUrl 登录 Cloudflare 账号即可永久保留。",
  };
}

async function deployDropBrowser(buildDir, projectDir, name) {
  // Package zip then drive Playwright
  const zipDir = path.join(projectDir, ".sitebuilder");
  fs.mkdirSync(zipDir, { recursive: true });
  const zipPath = path.join(zipDir, `${name}.zip`);
  createZip(buildDir, zipPath);

  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    // try playwright-core / global
    try {
      playwright = await import("playwright-core");
    } catch {
      throw new Error(
        "drop-browser method requires playwright. Install: npm i -D playwright && npx playwright install chromium\n" +
          `Zip ready for manual upload: ${zipPath}\n` +
          "Open https://cloudflare.com/drop and drop the zip."
      );
    }
  }

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  const result = {
    method: "drop-browser",
    zipPath,
    previewUrl: null,
    claimUrl: null,
    expiresNote:
      "Cloudflare Drop 未认领预览约 1 小时有效。点击 Claim 登录后可永久保留。",
  };

  try {
    await page.goto("https://www.cloudflare.com/drop", {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    // Accept ToS if modal appears
    const accept = page.getByRole("button", { name: /accept/i });
    if (await accept.isVisible({ timeout: 3000 }).catch(() => false)) {
      await accept.click();
    }

    // Find file input (hidden) or create one via drop
    let input = page.locator('input[type="file"]').first();
    if ((await input.count()) === 0) {
      // inject file input as fallback
      await page.evaluate(() => {
        const i = document.createElement("input");
        i.type = "file";
        i.id = "sitebuilder-file";
        i.style.display = "none";
        document.body.appendChild(i);
      });
      input = page.locator("#sitebuilder-file");
    }

    await input.setInputFiles(zipPath);

    // Wait for live URL — Drop shows workers.dev or similar after distribute
    const livePattern =
      /https:\/\/[a-z0-9.-]+\.(workers\.dev|pages\.dev|cloudflarepreview\.com)[^\s"']*/i;

    // Also watch for claim link
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText || "";
        return (
          /workers\.dev|claim|live|preview/i.test(text) &&
          /https:\/\//i.test(text)
        );
      },
      { timeout: 180000 }
    );

    // Give UI a moment to settle
    await page.waitForTimeout(2000);

    const bodyText = await page.locator("body").innerText();
    const urlMatch = bodyText.match(livePattern);
    if (urlMatch) result.previewUrl = urlMatch[0];

    const claimMatch =
      bodyText.match(/https:\/\/dash\.cloudflare\.com\/claim-preview\?[^\s]+/i) ||
      (await page
        .locator('a[href*="claim-preview"]')
        .first()
        .getAttribute("href")
        .catch(() => null));
    if (claimMatch) {
      result.claimUrl = typeof claimMatch === "string" ? claimMatch : claimMatch[0];
    }

    // Try copying from any visible link
    if (!result.previewUrl) {
      const hrefs = await page.$$eval("a[href]", (as) =>
        as.map((a) => a.href).filter((h) => /workers\.dev|pages\.dev/.test(h))
      );
      if (hrefs[0]) result.previewUrl = hrefs[0];
    }

    if (!result.previewUrl) {
      // screenshot for debugging
      const shot = path.join(zipDir, "drop-debug.png");
      await page.screenshot({ path: shot, fullPage: true });
      throw new Error(
        `Drop browser upload finished but preview URL not found. Debug screenshot: ${shot}. Zip: ${zipPath}`
      );
    }
  } finally {
    await browser.close();
  }

  return result;
}

function deployZipOnly(buildDir, projectDir, name) {
  const zipDir = path.join(projectDir, ".sitebuilder");
  fs.mkdirSync(zipDir, { recursive: true });
  const zipPath = path.join(zipDir, `${name}.zip`);
  createZip(buildDir, zipPath);
  return {
    method: "zip-only",
    zipPath,
    previewUrl: null,
    claimUrl: null,
    manualSteps: [
      "1. 打开 https://cloudflare.com/drop",
      `2. 将 zip 拖入页面：${zipPath}`,
      "3. 等待上传完成，复制预览 URL",
      "4. 如需永久保留：在 1 小时内点击 Claim 并登录 Cloudflare",
    ],
    expiresNote: "未认领 Drop 预览约 1 小时有效。无需账号即可获得临时预览。",
  };
}

function saveDeployMeta(projectDir, result) {
  const dir = path.join(projectDir, ".sitebuilder");
  fs.mkdirSync(dir, { recursive: true });
  const metaPath = path.join(dir, "last-deploy.json");
  const payload = {
    ...result,
    savedAt: new Date().toISOString(),
  };
  // strip huge raw logs
  if (payload.raw && payload.raw.length > 5000) {
    payload.raw = payload.raw.slice(-5000);
  }
  fs.writeFileSync(metaPath, JSON.stringify(payload, null, 2));
  return metaPath;
}

function openUrl(url) {
  const platform = process.platform;
  try {
    if (platform === "darwin") execFileSync("open", [url]);
    else if (platform === "win32") execFileSync("cmd", ["/c", "start", url]);
    else execFileSync("xdg-open", [url]);
  } catch {
    /* ignore */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = resolveDeployTarget(args.projectDir, args.dir, {
    build: args.build,
    includeSiblings: args.includeSiblings,
    onProgress: args.json ? undefined : (m) => console.error(`[resolve] ${m}`),
  });
  const buildDir = target.buildDir;
  const projectDir = target.projectDir;
  const analysis = analyzeBuildDir(buildDir);
  analysis.warnings = [
    ...(analysis.warnings || []),
    ...(target.warnings || []),
    ...(target.note ? [target.note] : []),
  ];

  const name = slugify(
    args.name ||
      (target.stagedFrom
        ? path.basename(target.stagedFrom, path.extname(target.stagedFrom))
        : path.basename(projectDir)) ||
      "sitebuilder-preview"
  );

  const errors = [];
  let result;

  async function tryDrop() {
    return deployViaDropApi(buildDir, {
      name,
      onProgress: args.json ? undefined : (m) => console.error(`[drop] ${m}`),
    });
  }

  async function tryMethod(method) {
    if (method === "drop") return tryDrop();
    if (method === "drop-browser")
      return deployDropBrowser(buildDir, projectDir, name);
    if (method === "temporary")
      return deployTemporary(buildDir, name, {
        forceTemporary: args.forceTemporary || true,
      });
    if (method === "zip-only") return deployZipOnly(buildDir, projectDir, name);
    throw new Error(`Unknown method: ${method}`);
  }

  // Default chain: drop → temporary → zip-only
  // Explicit method: try that first; unless --no-fallback, cascade on failure
  const chain =
    args.method === "drop" && !args.noFallback
      ? ["drop", "temporary", "zip-only"]
      : args.method === "drop-browser" && !args.noFallback
        ? ["drop-browser", "drop", "temporary", "zip-only"]
        : [args.method];

  for (const method of chain) {
    try {
      result = await tryMethod(method);
      if (result?.previewUrl || method === "zip-only") break;
      errors.push(`${method}: no previewUrl`);
    } catch (e) {
      errors.push(`${method}: ${e.message || e}`);
      if (args.noFallback || chain.length === 1) throw e;
      if (!args.json) {
        console.error(`[sitebuilder] ${method} failed, trying next…`);
        console.error(`  ${e.message || e}`);
      }
    }
  }

  if (!result) {
    throw new Error(`All deploy methods failed:\n- ${errors.join("\n- ")}`);
  }
  if (errors.length) result.fallbackLog = errors;

  result = {
    ok: true,
    scenario: target.scenario || null,
    framework: target.framework || null,
    projectDir,
    buildDir,
    stagedFrom: target.stagedFrom || null,
    fileCount: analysis.fileCount,
    totalSizeMB: analysis.totalSizeMB,
    maxFileMB: analysis.maxFileMB,
    maxFilePath: analysis.maxFilePath,
    hasIndex: analysis.hasIndex,
    withinDropLimits: analysis.withinDropLimits,
    warnings: analysis.warnings,
    name,
    ...result,
    constraints: {
      ...DROP_CONSTRAINTS,
      allowed: "HTML, CSS, JavaScript, images, fonts",
      unclaimedTtl: "~1 hour (60 minutes)",
      claimForPermanent: true,
      inputScenarios: [
        "html-file: single .html",
        "static-folder: folder with index.html / assets",
        "project: package.json app → dist/build/out (--build optional)",
      ],
    },
  };

  const metaPath = saveDeployMeta(projectDir, result);
  result.metaPath = metaPath;

  if (args.openClaim && result.claimUrl) openUrl(result.claimUrl);

  if (args.json) {
    const { raw, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log("");
    console.log("═══ Sitebuilder Deploy ═══");
    if (result.scenario) console.log(`Scenario:   ${result.scenario}`);
    if (result.framework) console.log(`Framework:  ${result.framework}`);
    console.log(`Method:     ${result.method}`);
    console.log(
      `Build:      ${result.buildDir} (${result.fileCount} files <2000, ${result.totalSizeMB} MB <100MB)`
    );
    if (result.maxFilePath != null) {
      console.log(
        `Largest:    ${result.maxFilePath} (${result.maxFileMB} MB ≤25MB)`
      );
    }
    console.log(
      `index.html: ${result.hasIndex ? "yes" : "NO"} · Drop limits: ${
        result.withinDropLimits ? "OK" : "FAIL"
      }`
    );
    if (result.previewUrl) console.log(`Preview:    ${result.previewUrl}`);
    if (result.claimUrl) console.log(`Claim:      ${result.claimUrl}`);
    if (result.zipPath) console.log(`Zip:        ${result.zipPath}`);
    if (result.expiresNote) console.log(`Note:       ${result.expiresNote}`);
    if (result.manualSteps) {
      console.log("Manual:");
      for (const s of result.manualSteps) console.log(`  ${s}`);
    }
    if (result.warnings?.length) {
      for (const w of result.warnings) console.log(`WARN: ${w}`);
    }
    console.log(`Meta:       ${metaPath}`);
    console.log("");
  }

  if (!result.previewUrl && result.method !== "zip-only") {
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
