#!/usr/bin/env node
// tools/merge-stations.mjs
//
// Merge two stations.json-style arrays into one.
//
// Order: base entries are kept first (so manually-curated seeds win on
// duplicate URLs); then de-duplicated additions are appended.
//
// Dedup keys: normalized URL, and rgId when present.
//
// Output style is "entry-per-line" — one JSON object per line, with the
// outer array brackets on their own lines. Valid JSON, but diffs survive
// surgical edits.
//
// Usage:
//   node tools/merge-stations.mjs <base.json> <add.json> [--out file] [--in-place]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseArgs(argv) {
  const o = { base: null, add: null, output: null, inPlace: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--in-place": o.inPlace = true; break;
      case "--out":      o.output = argv[++i]; break;
      case "-h":
      case "--help":     o.help = true; break;
      default:
        if      (!o.base) o.base = a;
        else if (!o.add)  o.add  = a;
    }
  }
  return o;
}

const normUrl = (u) => (u || "").trim().toLowerCase();

function compactArrayJSON(arr) {
  if (arr.length === 0) return "[]\n";
  const lines = arr.map(o => JSON.stringify(o));
  return "[\n  " + lines.join(",\n  ") + "\n]\n";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.base || !args.add) {
    console.log("Usage: node tools/merge-stations.mjs <base.json> <add.json> [--out file] [--in-place]");
    process.exit(args.help ? 0 : 1);
  }
  const basePath = resolve(args.base);
  const addPath  = resolve(args.add);
  const base = JSON.parse(await readFile(basePath, "utf8"));
  const add  = JSON.parse(await readFile(addPath, "utf8"));
  if (!Array.isArray(base) || !Array.isArray(add)) throw new Error("both inputs must be JSON arrays");

  const seenUrls = new Set(base.map(s => normUrl(s.url)).filter(Boolean));
  const seenIds  = new Set(base.map(s => s.rgId).filter(Boolean));

  const merged = base.slice();
  let added = 0, skipped = 0;
  for (const s of add) {
    const u = normUrl(s.url);
    if (!u)                              { skipped++; continue; }
    if (seenUrls.has(u))                 { skipped++; continue; }
    if (s.rgId && seenIds.has(s.rgId))   { skipped++; continue; }
    merged.push(s);
    seenUrls.add(u);
    if (s.rgId) seenIds.add(s.rgId);
    added++;
  }
  console.log(`base=${base.length}  add=${add.length}  → merged=${merged.length}  (+${added}, skipped ${skipped})`);

  const outputPath = args.inPlace
    ? basePath
    : (args.output || basePath.replace(/\.json$/i, "") + ".merged.json");
  await writeFile(outputPath, compactArrayJSON(merged));
  console.log(`wrote ${outputPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
