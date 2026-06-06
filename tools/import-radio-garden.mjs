#!/usr/bin/env node
// tools/import-radio-garden.mjs
//
// Append stations from radio.garden into ../stations.json (by id / url / place).
// Shared radio.garden helpers live in tools/lib/radio-garden.mjs.
//
// Usage:
//   node tools/import-radio-garden.mjs <url-or-id> [<url-or-id> …] [opts]
//
// <url-or-id> can be:
//   https://radio.garden/listen/<slug>/<channel-id>   one channel
//   https://radio.garden/visit/<slug>/<place-id>      all channels at a place
//   <channel-id>                                      raw id (e.g. zUYHDg63)
//
// Options:
//   --genre  a,b,c   genre tags to apply to all imports (recommended)
//   --lang   a,b     ISO 639-1 language codes
//   --country xx     override ISO-3166 alpha-2 (otherwise read from RG)
//   --proxy          keep the radio.garden CDN proxy URL instead of resolving 302
//   --dry-run        print what would be added, don't touch stations.json
//   -h, --help       show this message

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  RG, countryCodeFrom, resolveListenURL, channelInfo, expandPlaceItems, sleep,
} from "./lib/radio-garden.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIONS_PATH = join(HERE, "..", "stations.json");

// ── arg parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    ids: [], genre: [], lang: [], country: null,
    proxy: false, dryRun: false, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--genre":    out.genre   = csv(argv[++i]); break;
      case "--lang":     out.lang    = csv(argv[++i]); break;
      case "--country":  out.country = (argv[++i] || "").trim().toLowerCase() || null; break;
      case "--proxy":    out.proxy   = true; break;
      case "--dry-run":  out.dryRun  = true; break;
      case "-h":
      case "--help":     out.help    = true; break;
      default:           out.ids.push(a);
    }
  }
  return out;
}
const csv = (s) => (s || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

function printHelp() {
  console.log(`
Append radio.garden stations into ../stations.json.

  node tools/import-radio-garden.mjs <url-or-id> […] [options]

URL / id forms:
  https://radio.garden/listen/<slug>/<channel-id>
  https://radio.garden/visit/<slug>/<place-id>     (imports every channel at the place)
  <channel-id>                                      (raw id)

Options:
  --genre  <a,b,c>   genre tags (recommended; radio.garden has none)
  --lang   <a,b>     ISO 639-1 language codes
  --country <xx>     ISO-3166 alpha-2 override
  --proxy            keep radio.garden CDN URL instead of resolving 302
  --dry-run          print result, don't write stations.json
  -h, --help         this message
`);
}

// ── helpers ─────────────────────────────────────────────────────────
function parseRef(s) {
  if (/^[A-Za-z0-9_-]{6,}$/.test(s) && !s.includes("/")) {
    return { kind: "channel", id: s };
  }
  try {
    const u = new URL(s);
    let m = u.pathname.match(/\/(listen|visit)\/[^/]+\/([A-Za-z0-9_-]{6,})\/?$/);
    if (!m) m = u.pathname.match(/\/(listen|visit)\/([A-Za-z0-9_-]{6,})\/?$/);
    if (m) return { kind: m[1] === "listen" ? "channel" : "place", id: m[2] };
  } catch { /* fallthrough */ }
  return null;
}

function clean(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([_, v]) =>
      v !== undefined && v !== null && v !== "" &&
      !(Array.isArray(v) && v.length === 0)
    )
  );
}

async function importChannel(id, args) {
  const meta = await channelInfo(id);
  const url = args.proxy
    ? `${RG}/api/ara/content/listen/${id}/channel.mp3?type=channel`
    : await resolveListenURL(id);
  return {
    name: meta.name,
    url,
    country: args.country || countryCodeFrom(meta.countryTitle) || null,
    genre: args.genre.length ? args.genre.slice() : [],
    lang: args.lang.length ? args.lang.slice() : [],
    city: meta.city || null,
  };
}

// ── main ────────────────────────────────────────────────────────────
async function loadExisting() {
  try { return JSON.parse(await readFile(STATIONS_PATH, "utf8")); }
  catch { return []; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.ids.length === 0) { printHelp(); process.exit(args.help ? 0 : 1); }

  // 1. expand place IDs → channel IDs
  const channelIds = [];
  for (const raw of args.ids) {
    const ref = parseRef(raw);
    if (!ref) { console.warn(`skip (cannot parse): ${raw}`); continue; }
    if (ref.kind === "place") {
      try {
        const items = await expandPlaceItems(ref.id);
        const ids = items.map((it) => it.channelId);
        console.log(`place ${ref.id} → ${ids.length} channel(s)`);
        channelIds.push(...ids);
      } catch (e) {
        console.warn(`! place ${ref.id}: ${e.message}`);
      }
      await sleep(250);
    } else {
      channelIds.push(ref.id);
    }
  }

  // 2. dedup channelIds in this run
  const seenIds = new Set();
  const uniqueChannelIds = channelIds.filter((id) => {
    if (seenIds.has(id)) return false;
    seenIds.add(id); return true;
  });

  // 3. import each channel — dedup by normalized stream URL only.
  const existing = await loadExisting();
  const existingUrls = new Set(existing.map((s) => s.url));
  const fresh = [];
  const skipped = [];
  const errors = [];

  for (const id of uniqueChannelIds) {
    try {
      const entry = await importChannel(id, args);
      if (existingUrls.has(entry.url)) {
        skipped.push({ id, why: `url dup: ${entry.url}` });
        continue;
      }
      existingUrls.add(entry.url);
      fresh.push(clean(entry));
      console.log(`+ ${entry.name}  [${entry.country || "??"}${entry.city ? " · " + entry.city : ""}]`);
    } catch (err) {
      errors.push({ id, message: err.message });
      console.warn(`! ${id}: ${err.message}`);
    }
    await sleep(300);
  }

  // 4. report
  if (skipped.length) {
    console.log(`\nskipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s.id}  (${s.why})`);
  }
  if (errors.length) {
    console.warn(`\n${errors.length} error(s):`);
    for (const e of errors) console.warn(`  ${e.id}: ${e.message}`);
  }

  if (args.dryRun) {
    console.log(`\n--dry-run: would add ${fresh.length} entr${fresh.length === 1 ? "y" : "ies"}.`);
    console.log(JSON.stringify(fresh, null, 2));
    return;
  }

  if (fresh.length === 0) {
    console.log("\nNothing new to write.");
    return;
  }

  const merged = existing.concat(fresh);
  await writeFile(STATIONS_PATH, JSON.stringify(merged, null, 2) + "\n");
  console.log(`\nwrote ${merged.length} stations to ${STATIONS_PATH} (+${fresh.length})`);
}

main().catch((err) => { console.error(err); process.exit(1); });
