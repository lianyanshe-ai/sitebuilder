#!/usr/bin/env node
/**
 * fetch-style.mjs
 * Download a DESIGN.md from VoltAgent/awesome-design-md into the project.
 *
 * Usage:
 *   node fetch-style.mjs <styleId> [--out DESIGN.md] [--project dir] [--json] [--force]
 *   node fetch-style.mjs --list [--json]
 *   node fetch-style.mjs --resolve tsla
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, "..", "references", "styles-catalog.json");

function loadCatalog() {
  return JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8"));
}

export function resolveStyleId(input, catalog = loadCatalog()) {
  if (!input) return null;
  const raw = String(input).trim();
  const key = raw.toLowerCase();

  // exact id
  if (catalog.styles.some((s) => s.id === raw || s.id === key)) {
    return catalog.styles.find((s) => s.id === raw || s.id === key).id;
  }
  // alias
  if (catalog.aliases[key]) return catalog.aliases[key];
  // name match
  const byName = catalog.styles.find(
    (s) => s.name.toLowerCase() === key || s.name.toLowerCase().replace(/\s+/g, "") === key
  );
  if (byName) return byName.id;
  // fuzzy contains
  const fuzzy = catalog.styles.find(
    (s) =>
      s.id.includes(key) ||
      s.name.toLowerCase().includes(key) ||
      s.tags.some((t) => t === key)
  );
  if (fuzzy) return fuzzy.id;
  return null;
}

export function getStyleMeta(id, catalog = loadCatalog()) {
  return catalog.styles.find((s) => s.id === id) || null;
}

export async function fetchDesignMd(styleId, catalog = loadCatalog()) {
  const id = resolveStyleId(styleId, catalog);
  if (!id) {
    const hint = catalog.notes?.[String(styleId).toLowerCase()];
    throw new Error(
      `Unknown style: "${styleId}".${hint ? " " + hint : ""} Use --list to see all styles.`
    );
  }
  const url = `${catalog.rawBase}/${id}/DESIGN.md`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  }
  const content = await res.text();
  if (!content || content.length < 100) {
    throw new Error(`DESIGN.md for ${id} looks empty or invalid`);
  }
  return {
    id,
    url,
    content,
    meta: getStyleMeta(id, catalog),
    getdesignUrl: `${catalog.getdesignBase}/${id}/design-md`,
    sourceRepo: catalog.source,
  };
}

function parseArgs(argv) {
  const args = {
    style: null,
    out: "DESIGN.md",
    project: process.cwd(),
    json: false,
    force: false,
    list: false,
    resolve: null,
  };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--json") args.json = true;
    else if (a === "--force") args.force = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--project") args.project = path.resolve(argv[++i]);
    else if (a === "--resolve") args.resolve = argv[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown flag: ${a}`);
    else pos.push(a);
  }
  if (pos[0]) args.style = pos[0];
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const catalog = loadCatalog();

  if (args.list) {
    const list = catalog.styles.map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      vibe: s.vibe,
      bestFor: s.bestFor,
    }));
    if (args.json) console.log(JSON.stringify(list, null, 2));
    else {
      console.log(`Available styles (${list.length}) from awesome-design-md:\n`);
      for (const s of list) {
        console.log(`  ${s.id.padEnd(18)} ${s.name} — ${s.vibe}`);
      }
      console.log(`\nAliases: ${Object.keys(catalog.aliases).join(", ")}`);
    }
    return;
  }

  if (args.resolve) {
    const id = resolveStyleId(args.resolve, catalog);
    const out = { input: args.resolve, resolved: id, meta: id ? getStyleMeta(id, catalog) : null };
    console.log(args.json ? JSON.stringify(out, null, 2) : id || "(unresolved)");
    if (!id) process.exitCode = 1;
    return;
  }

  if (!args.style) {
    throw new Error("Usage: fetch-style.mjs <styleId> | --list | --resolve <name>");
  }

  const fetched = await fetchDesignMd(args.style, catalog);
  const outPath = path.isAbsolute(args.out)
    ? args.out
    : path.join(args.project, args.out);

  if (fs.existsSync(outPath) && !args.force) {
    // write alongside as DESIGN.<id>.md if default exists
    if (path.basename(outPath) === "DESIGN.md") {
      const alt = path.join(path.dirname(outPath), `DESIGN.${fetched.id}.md`);
      fs.writeFileSync(alt, fetched.content);
      // also overwrite DESIGN.md with force-soft: user wants style applied
      fs.writeFileSync(outPath, fetched.content);
      fetched.written = [outPath, alt];
    } else {
      throw new Error(`File exists: ${outPath} (use --force)`);
    }
  } else {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, fetched.content);
    fetched.written = [outPath];
  }

  // sidecar meta
  const metaPath = path.join(path.dirname(outPath), ".sitebuilder-style.json");
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        styleId: fetched.id,
        name: fetched.meta?.name,
        fetchedAt: new Date().toISOString(),
        source: fetched.url,
        getdesignUrl: fetched.getdesignUrl,
      },
      null,
      2
    )
  );

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          styleId: fetched.id,
          name: fetched.meta?.name,
          written: fetched.written,
          metaPath,
          url: fetched.url,
          vibe: fetched.meta?.vibe,
          note: catalog.notes?.[String(args.style).toLowerCase()] || null,
        },
        null,
        2
      )
    );
  } else {
    console.log(`Style: ${fetched.meta?.name || fetched.id} (${fetched.id})`);
    console.log(`Wrote: ${fetched.written.join(", ")}`);
    console.log(`Source: ${fetched.url}`);
    if (fetched.meta?.vibe) console.log(`Vibe: ${fetched.meta.vibe}`);
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
