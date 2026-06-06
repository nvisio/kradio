#!/usr/bin/env node
// tools/import-rg-new.mjs
// Add ONLY genuinely-new radio.garden stations. Two-stage dedup:
//   1) cheap: skip channels whose normalized name+country is already in stations.json
//   2) authoritative: resolve survivors → skip if URL already present
// Writes tools/rg-candidates.json (net-new). Bounded by --max-resolve.
//
//   node tools/import-rg-new.mjs [--max-resolve 3000] [--countries kr,jp] [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  listPlaces, expandPlaceItems, resolveListenURL,
  countryCodeFrom, nameKey, sleep,
} from "./lib/radio-garden.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const DRY = process.argv.includes("--dry-run");
const MAX_RESOLVE = parseInt(arg("--max-resolve", "3000"), 10);
const ONLY = (arg("--countries", "") || "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const stations = JSON.parse(await readFile(resolve("stations.json"), "utf8"));
  const knownNames = new Set(stations.map((s) => nameKey(s.name, s.country)));
  const knownUrls = new Set(stations.map((s) => normUrl(s.url)));

  const places = await listPlaces();
  let scannedPlaces = 0, nameDupes = 0, resolved = 0, failed = 0;
  const candidates = [];
  let capHit = false;

  for (const p of places) {
    const cc = countryCodeFrom(p.country);
    if (ONLY.length && (!cc || !ONLY.includes(cc))) continue;
    let items;
    try { items = await expandPlaceItems(p.id); } catch (e) { console.warn(`! place ${p.id}: ${e.message}`); continue; }
    scannedPlaces++;
    await sleep(250);

    for (const it of items) {
      // STAGE 1: cheap name+country dedup (no resolve)
      if (knownNames.has(nameKey(it.title, cc))) { nameDupes++; continue; }
      if (resolved >= MAX_RESOLVE) { capHit = true; break; }

      let url;
      try { url = await resolveListenURL(it.channelId); resolved++; }
      catch (e) { failed++; continue; }
      await sleep(300);

      // STAGE 2: authoritative URL dedup
      const k = normUrl(url);
      if (!k || knownUrls.has(k)) continue;
      knownUrls.add(k);
      knownNames.add(nameKey(it.title, cc));
      candidates.push({ name: it.title, url, country: cc || null, genre: [], lang: [], city: p.title || null });
      console.log(`+ ${it.title}  [${cc || "??"} · ${p.title}]`);
    }
    if (capHit) break;
  }

  console.error(`\nscanned places: ${scannedPlaces}, name-dupes skipped: ${nameDupes}, resolved: ${resolved}, resolve-fails: ${failed}, NET-NEW: ${candidates.length}${capHit ? " (hit --max-resolve cap)" : ""}`);
  if (DRY) { console.error("--dry-run: not writing"); return; }
  await writeFile(resolve("tools/rg-candidates.json"), JSON.stringify(candidates) + "\n", "utf8");
  console.error("wrote tools/rg-candidates.json");
}

main().catch((e) => { console.error(e); process.exit(1); });
