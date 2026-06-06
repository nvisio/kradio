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
  countryCodeFrom, nameKey, changedPlaces, nextSigs,
} from "./lib/radio-garden.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const DRY = process.argv.includes("--dry-run");
const FULL = process.argv.includes("--full");          // ignore signatures, scan every place
const CONCURRENCY = parseInt(arg("--concurrency", "30"), 10);
const MAX_RESOLVE = parseInt(arg("--max-resolve", "3000"), 10);
const ONLY = (arg("--countries", "") || "").split(",").map((c) => c.trim().toLowerCase()).filter(Boolean);
const SIGS_PATH = "tools/rg-place-sigs.json";
const normUrl = (u) => (u || "").trim().toLowerCase();

async function loadSigs() {
  try { return JSON.parse(await readFile(resolve(SIGS_PATH), "utf8")); }
  catch { return {}; }
}

async function main() {
  const stations = JSON.parse(await readFile(resolve("stations.json"), "utf8"));
  const knownNames = new Set(stations.map((s) => nameKey(s.name, s.country, s.city)));
  const knownUrls = new Set(stations.map((s) => normUrl(s.url)));

  const allPlaces = await listPlaces();
  const storedSigs = await loadSigs();
  // Only expand places that are new or whose size changed (unless --full).
  const candidatePlaces = FULL ? allPlaces : changedPlaces(allPlaces, storedSigs);
  const unchangedSkipped = allPlaces.length - candidatePlaces.length;

  let scannedPlaces = 0, nameDupes = 0, resolved = 0, failed = 0;
  const scanned = [];          // places actually expanded (for signature update)
  const candidates = [];
  let capHit = false;

  // Process one place: expand → per-channel two-stage dedup → resolve net-new.
  // The shared-state mutations (Sets, counters, arrays) are between awaits and
  // therefore atomic under Node's single-threaded event loop, so the dedup
  // check+add can't interleave across workers.
  async function processPlace(p) {
    if (capHit) return;
    const cc = countryCodeFrom(p.country);
    if (ONLY.length && (!cc || !ONLY.includes(cc))) return;
    let items;
    try { items = await expandPlaceItems(p.id); }
    catch (e) { console.warn(`! place ${p.id}: ${e.message}`); return; }
    scannedPlaces++;
    scanned.push(p);

    for (const it of items) {
      // STAGE 1: cheap name+country+city dedup (no resolve)
      if (knownNames.has(nameKey(it.title, cc, p.title))) { nameDupes++; continue; }
      if (resolved >= MAX_RESOLVE) { capHit = true; break; }

      let url;
      try { url = await resolveListenURL(it.channelId); resolved++; }
      catch (e) { failed++; continue; }

      // STAGE 2: authoritative URL dedup (check+add is synchronous → race-free)
      const k = normUrl(url);
      if (!k || knownUrls.has(k)) continue;
      knownUrls.add(k);
      knownNames.add(nameKey(it.title, cc, p.title));
      candidates.push({ name: it.title, url, country: cc || null, genre: [], lang: [], city: p.title || null });
      console.log(`+ ${it.title}  [${cc || "??"} · ${p.title}]`);
    }
  }

  // Concurrency pool: up to CONCURRENCY places processed at once.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidatePlaces.length) }, async () => {
      while (next < candidatePlaces.length && !capHit) {
        await processPlace(candidatePlaces[next++]);
      }
    })
  );

  console.error(`\nplaces: ${allPlaces.length} (unchanged skipped: ${unchangedSkipped}), scanned: ${scannedPlaces}, conc: ${CONCURRENCY}, name-dupes skipped: ${nameDupes}, resolved: ${resolved}, resolve-fails: ${failed}, NET-NEW: ${candidates.length}${capHit ? " (hit --max-resolve cap)" : ""}`);
  if (DRY) { console.error("--dry-run: not writing"); return; }
  await writeFile(resolve("tools/rg-candidates.json"), JSON.stringify(candidates) + "\n", "utf8");
  // Update place-size signatures so the next run skips unchanged places.
  // (Skip the signature write on a capped run — coverage was partial.)
  if (!capHit) {
    const sigs = nextSigs(storedSigs, scanned, allPlaces);
    await writeFile(resolve(SIGS_PATH), JSON.stringify(sigs) + "\n", "utf8");
    console.error(`wrote tools/rg-candidates.json + ${SIGS_PATH} (${Object.keys(sigs).length} place sigs)`);
  } else {
    console.error("wrote tools/rg-candidates.json (signatures NOT updated — cap hit, partial coverage)");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
