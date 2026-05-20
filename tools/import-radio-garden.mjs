#!/usr/bin/env node
// tools/import-radio-garden.mjs
//
// Append stations from radio.garden into ../stations.json.
//
// Usage:
//   node tools/import-radio-garden.mjs <url-or-id> [<url-or-id> …] [opts]
//
// <url-or-id> can be:
//   https://radio.garden/listen/<channel-id>/<slug>   one channel
//   https://radio.garden/visit/<place-id>/<slug>      all channels at a place
//   <channel-id>                                      raw 8-char id (e.g. zUYHDg63)
//
// Options:
//   --genre  a,b,c   genre tags to apply to all imports (recommended)
//   --lang   a,b     ISO 639-1 language codes
//   --country xx     override ISO-3166 alpha-2 (otherwise read from RG)
//   --proxy          keep the radio.garden CDN proxy URL instead of
//                    following the 302 to the broadcaster's stream
//                    (use only if the direct URL turns out unreachable)
//   --dry-run        print what would be added, don't touch stations.json
//   -h, --help       show this message
//
// Notes:
//   * The default ("resolve") mode follows radio.garden's 302 redirect on
//     /api/ara/content/listen/<id>/channel.mp3 to grab the broadcaster's
//     real stream URL — that's what the K-Radio Tuner deep link needs,
//     because radio.garden's CDN often 403s non-browser User-Agents.
//   * radio.garden has no public genre taxonomy, so genres are taken
//     verbatim from --genre. Re-run the script per genre bucket.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIONS_PATH = join(HERE, "..", "stations.json");
const RG = "https://radio.garden";
const UA = "kradio-importer/1.0 (+https://nvis.io/kradio)";

// ── arg parsing ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    ids: [], genre: [], lang: [], country: null,
    proxy: false, dryRun: false, help: false
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
const csv = (s) => (s || "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);

function printHelp() {
  // strip the top JSDoc-ish banner from this file
  const banner = `
Append radio.garden stations into ../stations.json.

  node tools/import-radio-garden.mjs <url-or-id> […] [options]

URL / id forms:
  https://radio.garden/listen/<channel-id>/<slug>
  https://radio.garden/visit/<place-id>/<slug>     (imports every channel at the place)
  <channel-id>                                      (raw 8-char id)

Options:
  --genre  <a,b,c>   genre tags (recommended; radio.garden has none)
  --lang   <a,b>     ISO 639-1 language codes
  --country <xx>     ISO-3166 alpha-2 override
  --proxy            keep radio.garden CDN URL instead of resolving 302
  --dry-run          print result, don't write stations.json
  -h, --help         this message

Examples:
  node tools/import-radio-garden.mjs --genre jazz \\
       https://radio.garden/listen/Rt8K9pPS/jazz-radio
  node tools/import-radio-garden.mjs --genre kpop --country kr \\
       https://radio.garden/visit/seoul/abcd1234
`;
  console.log(banner);
}

// ── helpers ─────────────────────────────────────────────────────────
function parseRef(s) {
  if (/^[A-Za-z0-9_-]{6,}$/.test(s) && !s.includes("/")) {
    return { kind: "channel", id: s };
  }
  try {
    const u = new URL(s);
    // radio.garden URLs are /(listen|visit)/<slug>/<id>; the id is the trailing
    // 6+ alphanum component. Fall back to /(listen|visit)/<id> for legacy URLs.
    let m = u.pathname.match(/\/(listen|visit)\/[^/]+\/([A-Za-z0-9_-]{6,})\/?$/);
    if (!m) m = u.pathname.match(/\/(listen|visit)\/([A-Za-z0-9_-]{6,})\/?$/);
    if (m) return { kind: m[1] === "listen" ? "channel" : "place", id: m[2] };
  } catch { /* fallthrough */ }
  return null;
}

async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.json();
}

async function resolveListenURL(channelId) {
  const u = `${RG}/api/ara/content/listen/${channelId}/channel.mp3?type=channel`;
  const r = await fetch(u, {
    redirect: "manual",
    headers: { "User-Agent": UA }
  });
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const loc = r.headers.get("location");
    if (loc) return loc;
  }
  // Some channels respond 200 directly (proxying); fall back to the proxy URL.
  if (r.ok) return u;
  throw new Error(`listen redirect missing for ${channelId} (HTTP ${r.status})`);
}

// Common country-name → ISO 3166-1 alpha-2 (lower). Extend as needed.
const COUNTRY_NAME_TO_CODE = {
  "south korea": "kr", "korea": "kr", "korea, republic of": "kr",
  "north korea": "kp",
  "japan": "jp",
  "united states": "us", "united states of america": "us", "usa": "us",
  "united kingdom": "gb", "uk": "gb", "england": "gb",
  "france": "fr", "germany": "de", "spain": "es", "italy": "it",
  "netherlands": "nl", "sweden": "se", "norway": "no", "finland": "fi",
  "denmark": "dk", "ireland": "ie", "portugal": "pt", "belgium": "be",
  "switzerland": "ch", "austria": "at", "poland": "pl", "czech republic": "cz",
  "canada": "ca", "mexico": "mx", "brazil": "br", "argentina": "ar",
  "chile": "cl", "colombia": "co", "australia": "au", "new zealand": "nz",
  "china": "cn", "taiwan": "tw", "hong kong": "hk", "singapore": "sg",
  "thailand": "th", "vietnam": "vn", "india": "in", "indonesia": "id",
  "philippines": "ph", "malaysia": "my", "turkey": "tr", "greece": "gr",
  "russia": "ru", "ukraine": "ua", "israel": "il", "south africa": "za"
};

function countryCodeFrom(title) {
  if (!title) return null;
  const k = title.toLowerCase().trim();
  if (COUNTRY_NAME_TO_CODE[k]) return COUNTRY_NAME_TO_CODE[k];
  // already a 2-letter code?
  if (/^[a-z]{2}$/.test(k)) return k;
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

// ── place / channel resolution ─────────────────────────────────────
async function expandPlace(placeId) {
  // /api/ara/content/page/<placeId>/channels returns sections of items;
  // each item.page.url looks like "/listen/<slug>/<channelId>" — id is last.
  const data = await getJSON(`${RG}/api/ara/content/page/${placeId}/channels`);
  const ids = [];
  const sections = data?.data?.content || data?.content || [];
  for (const sec of sections) {
    for (const item of (sec.items || [])) {
      const url = item.page?.url || item.url || item.href || "";
      const m = url.match(/\/listen\/[^/]+\/([A-Za-z0-9_-]{6,})\/?$/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
  }
  return ids;
}

async function importChannel(id, args) {
  const info = await getJSON(`${RG}/api/ara/content/channel/${id}`);
  const d = info?.data || info || {};
  const name = d.title || d.subtitle || id;
  const place = d.place || {};
  // radio.garden's country.id is their internal place id (e.g. "V7SPHPgx"),
  // NOT a country code — only the title is human-readable ("Australia").
  const country = d.country?.title || null;
  const city = place.title || null;
  const url = args.proxy
    ? `${RG}/api/ara/content/listen/${id}/channel.mp3?type=channel`
    : await resolveListenURL(id);

  return {
    name,
    url,
    country: args.country || countryCodeFrom(country) || null,
    genre: args.genre.length ? args.genre.slice() : [],
    lang: args.lang.length ? args.lang.slice() : [],
    city: city || null
  };
}

// ── main ────────────────────────────────────────────────────────────
async function loadExisting() {
  try { return JSON.parse(await readFile(STATIONS_PATH, "utf8")); }
  catch { return []; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
        const ids = await expandPlace(ref.id);
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
  const uniqueChannelIds = channelIds.filter(id => {
    if (seenIds.has(id)) return false;
    seenIds.add(id); return true;
  });

  // 3. import each channel — dedup by normalized stream URL only.
  const existing = await loadExisting();
  const existingUrls = new Set(existing.map(s => s.url));
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

main().catch(err => { console.error(err); process.exit(1); });
