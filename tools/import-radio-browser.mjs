#!/usr/bin/env node
// tools/import-radio-browser.mjs
// For each country: fetch RB top-by-votes → map/quality-filter →
//   (a) union the top into featured/{cc}.json (preserve curation),
//   (b) emit net-new (not already in stations.json) to tools/rb-candidates.json.
// Writes featured files in place; the catalogue merge happens later via merge-stations.
//
//   node tools/import-radio-browser.mjs [--limit 500] [--featured-cap 50] [--countries kr,jp,...] [--dry-run]

import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverMirrors, fetchTopByCountry } from "./lib/radio-browser.mjs";
import { mapStation, normUrl } from "./rb-to-catalog.mjs";
import { unionFeatured } from "./featured-merge.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const DRY = process.argv.includes("--dry-run");
const LIMIT = parseInt(arg("--limit", "500"), 10);
const CAP = parseInt(arg("--featured-cap", "50"), 10);

async function featuredCountries() {
  const explicit = arg("--countries", "");
  if (explicit) return explicit.split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
  const files = (await readdir(resolve("featured"))).filter((f) => f.endsWith(".json"));
  return files.map((f) => f.replace(/\.json$/i, "").toLowerCase());
}

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(resolve(path), "utf8")); }
  catch { return fallback; }
}

async function writePretty(path, arr) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(arr, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

async function main() {
  const mirrors = await discoverMirrors();
  console.error(`mirrors: ${mirrors.slice(0, 3).join(", ")}`);

  const stations = await loadJSON("stations.json", []);
  const known = new Set(stations.map((s) => normUrl(s.url)));

  const countries = await featuredCountries();
  const candidates = [];
  let featuredChanged = 0;

  for (const cc of countries) {
    let raw;
    try { raw = await fetchTopByCountry(mirrors, cc, { limit: LIMIT }); }
    catch (e) { console.error(`  ${cc}: FETCH FAILED — ${e.message} (skipping)`); continue; }

    const mapped = [];
    let rejected = 0;
    for (const rb of raw) {
      const r = mapStation(rb);
      if (r.ok) mapped.push(r.entry); else rejected++;
    }

    // (a) featured union (RB returned them in votes order)
    const fpath = join("featured", `${cc}.json`);
    const existing = await loadJSON(fpath, []);
    const merged = unionFeatured(existing, mapped, CAP);
    if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      if (!DRY) await writePretty(resolve(fpath), merged);
      featuredChanged++;
    }

    // (b) net-new catalogue candidates
    let fresh = 0;
    for (const e of mapped) {
      const k = normUrl(e.url);
      if (!known.has(k)) { known.add(k); candidates.push(e); fresh++; }
    }
    console.error(`  ${cc}: fetched ${raw.length}, ok ${mapped.length}, rejected ${rejected}, net-new ${fresh}, featured ${existing.length}→${merged.length}`);
  }

  if (!DRY) await writeFile(resolve("tools/rb-candidates.json"), JSON.stringify(candidates) + "\n", "utf8");
  console.error(`\ntotal net-new candidates: ${candidates.length}; featured files changed: ${featuredChanged}${DRY ? " (dry-run, nothing written)" : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
