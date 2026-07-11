#!/usr/bin/env node
/**
 * drop-api.mjs — Deploy static assets via Cloudflare Drop provisioning API
 * (same backend as https://www.cloudflare.com/drop — no user API token required)
 *
 * Critical: multipart part Content-Type MUST match real MIME (text/html etc).
 * Using application/octet-stream makes browsers DOWNLOAD instead of render.
 *
 * Usage:
 *   node drop-api.mjs <buildDir> [--name site-name] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const API = "https://api.cloudflare.com/client/v4";
const TERMS = "https://www.cloudflare.com/terms/";
const PRIVACY = "https://www.cloudflare.com/privacypolicy/";
const COMPAT_DATE = "2025-05-19";

/** Same map as Cloudflare Drop frontend (UploadStage) */
const MIME = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  pdf: "application/pdf",
  wasm: "application/wasm",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  map: "application/json",
  webmanifest: "application/manifest+json",
};

function b64urlToBuf(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

/** Drop PoW: k outer rounds × g inner SHA-256, emit k+1 checkpoints */
export function solvePow({ seed, k, g, onProgress }) {
  if (!Number.isInteger(k) || k <= 0) throw new Error(`PoW: invalid k (${k})`);
  if (!Number.isInteger(g) || g <= 0) throw new Error(`PoW: invalid g (${g})`);
  if (k * g > 64_000_000) throw new Error(`PoW: too many iterations ${k * g}`);

  let a = sha256(b64urlToBuf(seed));
  const checkpoints = [a];
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < g; j++) a = sha256(a);
    checkpoints.push(a);
    if (onProgress && (i & 15) === 0) onProgress(i, k);
  }
  const concat = Buffer.concat(checkpoints);
  return { checkpoints: concat.toString("base64") };
}

function extOf(name) {
  const i = String(name).lastIndexOf(".");
  return i === -1 ? "" : String(name).slice(i + 1).toLowerCase();
}

function mimeFor(filenameOrPath) {
  const ext = extOf(filenameOrPath);
  return MIME[ext] || "application/octet-stream";
}

/** Hash = first 32 hex of SHA256( base64(fileBytes) + extensionWithoutDot ) */
function fileHash(buf, filename) {
  const b64 = buf.toString("base64");
  const ext = extOf(filename);
  return createHash("sha256")
    .update(b64 + ext)
    .digest("hex")
    .slice(0, 32);
}

function walkFiles(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (name === ".DS_Store" || name.startsWith("._") || name === "__MACOSX") continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkFiles(full, base, out);
    else if (st.isFile()) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      out.push({ abs: full, rel, webPath: `/${rel}` });
    }
  }
  return out;
}

/**
 * Build Drop-compatible manifest + hashed file bodies.
 * byHash[hash] = { b64, size, mime, paths[] }
 */
function buildManifest(buildDir) {
  const files = walkFiles(buildDir);
  if (!files.length) throw new Error(`No files in ${buildDir}`);
  const manifest = {};
  /** @type {Record<string, { b64: string, size: number, mime: string, paths: string[] }>} */
  const byHash = {};
  for (const f of files) {
    const buf = fs.readFileSync(f.abs);
    const base = path.basename(f.rel);
    const hash = fileHash(buf, base);
    const b64 = buf.toString("base64");
    const mime = mimeFor(f.rel);
    manifest[f.webPath] = { hash, size: buf.length };
    if (!byHash[hash]) {
      byHash[hash] = { b64, size: buf.length, mime, paths: [f.webPath] };
    } else {
      byHash[hash].paths.push(f.webPath);
      // Prefer text/html over octet-stream if collision
      if (mime.startsWith("text/html")) byHash[hash].mime = mime;
    }
  }
  return { manifest, byHash, fileCount: files.length };
}

/** Create a Blob matching Drop's File([base64String], hash, { type: mime }) */
function assetPart(hash, file) {
  // Drop stores the *base64 string* as the part body when ?base64=true
  if (typeof File !== "undefined") {
    return new File([file.b64], hash, { type: file.mime });
  }
  return new Blob([file.b64], { type: file.mime });
}

async function api(pathname, { method = "GET", token, claimToken, body, formData, signal } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (claimToken) headers["X-Claim-Token"] = claimToken;
  let payload = body;
  if (formData) {
    payload = formData;
  } else if (body && typeof body === "object" && !(body instanceof Buffer)) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: payload,
    signal,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const msg =
      json?.errors?.[0]?.message ||
      json?.raw ||
      text ||
      res.statusText;
    throw new Error(`Drop API ${method} ${pathname} → ${res.status}: ${msg}`);
  }
  return json;
}

function scriptName(name) {
  const base = String(name || "drop-site")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return `drop-${base || "site"}-${randomUUID().slice(0, 8)}`;
}

function metadata(jwt) {
  return {
    compatibility_date: COMPAT_DATE,
    main_module: undefined, // assets-only worker
    assets: {
      jwt,
      config: {
        // Match Drop: SPA-style so / serves index.html
        not_found_handling: "single-page-application",
        html_handling: "auto-trailing-slash",
      },
    },
    bindings: [{ name: "ASSETS", type: "assets" }],
  };
}

function cleanMetadata(jwt) {
  // Avoid sending main_module: undefined in JSON
  const m = metadata(jwt);
  delete m.main_module;
  return m;
}

/**
 * Probe live URL until it is browser-viewable (or fail).
 * Hard requirements for HTML sites:
 *  - HTTP 200 (not 404 "Page not found" HTML)
 *  - Content-Type: text/html (NOT application/octet-stream → would force download)
 *  - No Content-Disposition: attachment
 *  - Body looks like real document (not CF error shell)
 *  - Optional: must contain a marker string from the source file
 *  - Stability: two consecutive successes (edge propagation)
 */
export async function verifyPreviewUrl(
  url,
  { timeoutMs = 60000, expectHtml = true, bodyMarker = null, minBytes = 64 } = {}
) {
  const start = Date.now();
  let last = { ok: false, status: 0, contentType: "", disposition: "", sample: "" };
  let streak = 0;

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        cache: "no-store",
      });
      const contentType = res.headers.get("content-type") || "";
      const disposition = res.headers.get("content-disposition") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString("utf8");
      const sample = text.slice(0, 240);
      const title = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
      last = {
        ok: res.ok,
        status: res.status,
        contentType,
        disposition,
        sample,
        title,
        size: buf.length,
      };

      if (res.status !== 200) {
        streak = 0;
        last.error = `HTTP ${res.status}`;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (disposition && /attachment/i.test(disposition)) {
        streak = 0;
        last.error = `content-disposition is attachment (${disposition}) — browser will download`;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (buf.length < minBytes) {
        streak = 0;
        last.error = `body too small (${buf.length} bytes)`;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (expectHtml) {
        const isHtmlType =
          /text\/html/i.test(contentType) ||
          /application\/xhtml\+xml/i.test(contentType);
        const looksHtml =
          /^\s*</.test(sample) && /<!doctype html|<html[\s>]/i.test(sample);
        const isCfErrorPage =
          /page not found/i.test(title) ||
          /error code:\s*\d+/i.test(text.slice(0, 500)) ||
          /workers\.dev.*not found/i.test(text.slice(0, 800));

        if (!isHtmlType) {
          streak = 0;
          last.error = `Content-Type is "${contentType || "(empty)"}" (want text/html). Browsers may force download when type is application/octet-stream.`;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (!looksHtml || isCfErrorPage) {
          streak = 0;
          last.error = isCfErrorPage
            ? `Got HTML error shell (title=${JSON.stringify(title)}) — assets not ready on edge`
            : `Body does not look like HTML`;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (bodyMarker && !text.includes(bodyMarker)) {
          streak = 0;
          last.error = `Body missing expected marker ${JSON.stringify(bodyMarker).slice(0, 60)}`;
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }

        streak += 1;
        // Need several consecutive hits — Drop edges can 404 briefly after deploy
        if (streak >= 3) {
          return { ...last, verified: true, mode: "mime-html-stable" };
        }
        await new Promise((r) => setTimeout(r, 900));
        continue;
      }

      streak += 1;
      if (streak >= 3) return { ...last, verified: true, mode: "ok-stable" };
    } catch (e) {
      streak = 0;
      last.error = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ...last, verified: false };
}

/**
 * Full Drop deploy pipeline with Content-Type verification.
 */
export async function deployViaDropApi(buildDir, { name = "site", onProgress } = {}) {
  const log = (msg) => onProgress?.(msg);

  log("challenge");
  const chRes = await api("/provisioning/previews/challenge", {
    method: "POST",
    body: {},
  });
  const challenge = chRes.result;
  if (!challenge?.challengeToken || !challenge?.seed) {
    throw new Error("Challenge response missing token/seed");
  }

  log(`pow k=${challenge.k} g=${challenge.g}`);
  const t0 = Date.now();
  const solution = solvePow({
    seed: challenge.seed,
    k: challenge.k,
    g: challenge.g,
    onProgress: (j, k) => {
      if (j % 200 === 0) log(`pow ${j}/${k}`);
    },
  });
  log(`pow done ${Date.now() - t0}ms`);

  log("provision");
  const provRes = await api("/provisioning/previews", {
    method: "POST",
    body: {
      client: "web",
      source: "drop",
      termsOfService: TERMS,
      privacyPolicy: PRIVACY,
      acceptTermsOfService: "yes",
      challengeToken: challenge.challengeToken,
      solution,
    },
  });
  const prov = provRes.result;
  const accountId = prov?.account?.id;
  const apiToken = prov?.account?.apiToken;
  const claimToken = prov?.claim?.token;
  const claimUrl = prov?.claim?.url;
  const expiresAt = prov?.account?.expiresAt;
  if (!accountId || !apiToken || !claimToken) {
    throw new Error(`Provisioning incomplete: ${JSON.stringify(provRes).slice(0, 400)}`);
  }

  const sName = scriptName(name);
  log(`script ${sName}`);

  const { manifest, byHash, fileCount } = buildManifest(buildDir);
  // Ensure we have an index for /
  const hasIndex =
    manifest["/index.html"] || manifest["/index.htm"] || manifest["/INDEX.HTML"];
  if (!hasIndex) {
    throw new Error(
      "Build has no /index.html — Drop will not render a homepage. Stage the entry HTML as index.html first."
    );
  }
  log(`manifest ${fileCount} files (index.html ok, mime=${byHash[manifest["/index.html"]?.hash || manifest["/index.htm"]?.hash]?.mime})`);

  log("upload-session");
  const sessionRes = await api(
    `/accounts/${accountId}/workers/scripts/${sName}/assets-upload-session`,
    {
      method: "POST",
      token: apiToken,
      body: { manifest },
    }
  );
  const session = sessionRes.result || sessionRes;
  let completionJwt = session.jwt;
  const buckets = session.buckets || [];

  // Upload asset buckets — Content-Type on each part is CRITICAL
  if (buckets.length) {
    log(`upload ${buckets.length} bucket(s)`);
    for (const bucket of buckets) {
      const hashes = Array.isArray(bucket) ? bucket : bucket?.hashes || bucket;
      const list = Array.isArray(hashes) ? hashes : [];
      const fd = new FormData();
      for (const h of list) {
        const file = byHash[h];
        if (!file) continue;
        fd.set(h, assetPart(h, file), h);
      }
      const up = await api(
        `/accounts/${accountId}/workers/assets/upload?base64=true`,
        {
          method: "POST",
          // Drop uses the *session* JWT here, not account apiToken
          token: completionJwt || apiToken,
          formData: fd,
        }
      );
      const nextJwt = up.result?.jwt ?? up.jwt;
      if (nextJwt) completionJwt = nextJwt;
    }
  }

  if (!completionJwt) {
    throw new Error("No completion JWT after asset upload");
  }

  // Bind assets (Drop provisioning endpoint) — same MIME-typed parts as web UI
  log("bind-assets");
  const fdBind = new FormData();
  fdBind.set("metadata", JSON.stringify(cleanMetadata(completionJwt)));
  fdBind.set("manifest", JSON.stringify(manifest));
  for (const [h, file] of Object.entries(byHash)) {
    fdBind.set(h, assetPart(h, file), h);
  }
  await api(
    `/provisioning/previews/accounts/${accountId}/scripts/${sName}/assets?base64=true`,
    {
      method: "POST",
      claimToken,
      formData: fdBind,
    }
  );

  // Deploy Worker (metadata only — same as Drop DistributeStage / JT)
  log("deploy-script");
  const fdMeta = new FormData();
  fdMeta.set("metadata", JSON.stringify(cleanMetadata(completionJwt)));
  await api(`/accounts/${accountId}/workers/scripts/${sName}`, {
    method: "PUT",
    token: apiToken,
    formData: fdMeta,
  });

  log("enable-subdomain");
  await api(`/accounts/${accountId}/workers/scripts/${sName}/subdomain`, {
    method: "POST",
    token: apiToken,
    body: { enabled: true },
  });

  const subRes = await api(`/accounts/${accountId}/workers/subdomain`, {
    method: "GET",
    token: apiToken,
  });
  const subdomain = subRes.result?.subdomain || subRes.subdomain;
  if (!subdomain) {
    throw new Error("Could not resolve workers.dev subdomain");
  }

  const previewUrl = `https://${sName}.${subdomain}.workers.dev`;

  // Marker from index.html so we don't accept generic CF 404 shells
  let bodyMarker = null;
  try {
    const idxPath = ["index.html", "index.htm"]
      .map((n) => path.join(buildDir, n))
      .find((p) => fs.existsSync(p));
    if (idxPath) {
      const raw = fs.readFileSync(idxPath, "utf8");
      const t = (raw.match(/<title[^>]*>([^<]{4,80})<\/title>/i) || [])[1];
      if (t) bodyMarker = t.trim().slice(0, 40);
      else {
        const chunk = raw.replace(/\s+/g, " ").trim().slice(80, 140);
        if (chunk.length >= 12) bodyMarker = chunk;
      }
    }
  } catch {
    /* ignore */
  }

  log("verify-renderable");
  const verify = await verifyPreviewUrl(previewUrl, {
    timeoutMs: 70000,
    expectHtml: true,
    bodyMarker,
    minBytes: 200,
  });
  if (!verify.verified) {
    throw new Error(
      `Deployed but page is not browser-viewable.\n` +
        `  URL: ${previewUrl}\n` +
        `  status: ${verify.status}\n` +
        `  Content-Type: ${verify.contentType || "(empty)"}\n` +
        `  Content-Disposition: ${verify.disposition || "(none)"}\n` +
        `  title: ${JSON.stringify(verify.title || "")}\n` +
        `  detail: ${verify.error || "unknown"}\n` +
        `  sample: ${JSON.stringify((verify.sample || "").slice(0, 80))}\n` +
        `Note: application/octet-stream → browser downloads; 404 HTML shell → edge not ready.`
    );
  }
  log(`live (${verify.contentType}, ${verify.size} bytes)`);

  return {
    method: "drop",
    source: "https://www.cloudflare.com/drop",
    previewUrl,
    claimUrl,
    expiresAt,
    claimWithin: expiresAt
      ? `${Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000))} minutes`
      : "~60 minutes",
    account: prov.account?.name || accountId,
    scriptName: sName,
    accountId,
    fileCount,
    temporary: true,
    permanent: false,
    contentType: verify.contentType,
    verified: true,
    expiresNote:
      "Cloudflare Drop 未认领预览约 1 小时有效。打开 claimUrl 登录即可永久保留。无需提供 API。",
  };
}

function parseArgs(argv) {
  const args = { buildDir: null, name: "site", json: false };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--name") args.name = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  if (!pos[0]) throw new Error("Usage: drop-api.mjs <buildDir> [--name x] [--json]");
  args.buildDir = path.resolve(pos[0]);
  return args;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  deployViaDropApi(args.buildDir, {
    name: args.name,
    onProgress: args.json ? undefined : (m) => console.error(`[drop] ${m}`),
  })
    .then((r) => {
      if (args.json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`Preview: ${r.previewUrl}`);
        console.log(`Type:    ${r.contentType}`);
        console.log(`Claim:   ${r.claimUrl}`);
        console.log(`Note:    ${r.expiresNote}`);
      }
    })
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}
