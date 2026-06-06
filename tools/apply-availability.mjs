#!/usr/bin/env node
// tools/apply-availability.mjs
// Pure mergeVerdict(entry, verdict); harness rewrites featured/{cc}.json
// atomically in the compact one-object-per-line style.
//
//   node tools/apply-availability.mjs verdicts.json
//   verdicts.json: [{ url, availability, countries?, type?, stationId? }, …]

import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function mergeVerdict(entry, verdict) {
  if (!verdict || verdict.availability === "global") {
    return { name: entry.name, url: entry.url };
  }
  const out = { name: entry.name };
  if (entry.url) out.url = entry.url;            // keep url (also radiko fallback)
  out.availability = verdict.availability;
  if (verdict.countries && verdict.countries.length) {
    out.countries = verdict.countries.map((c) => String(c).toLowerCase());
  }
  if (verdict.type && verdict.type !== "direct") out.type = verdict.type;
  if (verdict.stationId) out.stationId = verdict.stationId;
  return out;
}

// Featured files are 2-space pretty-printed; preserve that for minimal diffs.
const formatFeatured = (arr) => JSON.stringify(arr, null, 2) + "\n";
const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const verdictsPath = process.argv[2];
  if (!verdictsPath) { console.error("usage: node tools/apply-availability.mjs verdicts.json"); process.exit(1); }
  const verdicts = JSON.parse(await readFile(resolve(verdictsPath), "utf8"));
  const byUrl = new Map(verdicts.map((v) => [normUrl(v.url), v]));
  const dir = resolve("featured");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  let changedFiles = 0, changedEntries = 0;
  for (const f of files) {
    const path = join(dir, f);
    const arr = JSON.parse(await readFile(path, "utf8"));
    let touched = false;
    const next = arr.map((entry) => {
      const v = byUrl.get(normUrl(entry.url));
      if (!v) return entry;
      const merged = mergeVerdict(entry, v);
      if (JSON.stringify(merged) !== JSON.stringify(entry)) { touched = true; changedEntries++; }
      return merged;
    });
    if (touched) {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, formatFeatured(next), "utf8");
      await rename(tmp, path);
      changedFiles++;
    }
  }
  console.error(`applied ${verdicts.length} verdicts → ${changedEntries} entries in ${changedFiles} files`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
