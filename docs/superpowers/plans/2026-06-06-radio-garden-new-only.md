# radio.garden new-only top-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add only genuinely-new radio.garden stations to the catalogue cheaply, via a two-stage (name then URL) dedup that avoids re-resolving the ~38k already-imported channels, and fold the result into PR #1.

**Architecture:** Extract radio.garden's reusable fetch helpers into `tools/lib/radio-garden.mjs` (with an upgraded country-name→code mapper and pure dedup helpers, TDD'd), refactor the existing CLI to use the lib, add a `tools/import-rg-new.mjs` orchestrator that name-prefilters before resolving, then reuse the existing probe→drop-dead→enrich→merge→index pipeline on branch `bot/station-import-first`.

**Tech Stack:** Node ≥20 built-ins (`node:test`, `fetch`, `Intl.DisplayNames`) — no new deps.

**Repo:** `/Users/moon/Projects/claude/kradio` → `nvisio/kradio`

**Spec:** `docs/superpowers/specs/2026-06-06-radio-garden-new-only-design.md`

**Node:** prefix `node` with `PATH="/usr/local/opt/node@22/bin:$PATH"`.

**Verified radio.garden API:** `GET /api/ara/content/places` → `data.list:[{id,title,country,size}]` (12,626 places); `GET /api/ara/content/page/{id}/channels` → items with `page.url=/listen/<slug>/<channelId>` + `title`; `GET /api/ara/content/listen/{id}/channel.mp3?type=channel` → 302 to the real stream. Existing `tools/import-radio-garden.mjs` already implements `expandPlace`/`resolveListenURL`/`channelInfo` — reuse them.

**Branch note:** Tasks 1–3 (lib/tool/tests + CLI refactor) commit to `main`. Task 4 (the run) happens on `bot/station-import-first` and updates PR #1.

---

## File Structure

```
tools/
├── lib/radio-garden.mjs          # NEW — listPlaces, expandPlaceItems, resolveListenURL,
│                                 #        channelInfo, countryCodeFrom (upgraded), nameKey, isKnown
├── lib/radio-garden.test.mjs     # NEW — node:test for the pure parts
├── import-radio-garden.mjs       # MODIFY — import shared fns from the lib (behavior unchanged)
├── import-rg-new.mjs             # NEW — new-only orchestrator (name-prefilter → resolve → dedup)
├── rg-candidates.json            # artifact (already gitignored)
├── probe-streams.mjs             # EXISTING (reused)
├── drop-dead-candidates.mjs      # EXISTING (reused)
├── enrich-stations.mjs           # EXISTING (reused)
├── merge-stations.mjs            # EXISTING (reused)
└── build-index.mjs               # EXISTING (reused)
```

---

## Task 1: radio.garden lib — pure helpers (TDD)

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/lib/radio-garden.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/lib/radio-garden.test.mjs`

This task builds the lib with its **pure** functions first (network functions are added in Task 2, smoke-tested live). TDD the pure parts.

- [ ] **Step 1: Write the failing test**

`tools/lib/radio-garden.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { countryCodeFrom, nameKey, isKnown } from "./radio-garden.mjs";

test("countryCodeFrom: common names via Intl", () => {
  assert.equal(countryCodeFrom("Germany"), "de");
  assert.equal(countryCodeFrom("South Korea"), "kr");
  assert.equal(countryCodeFrom("United States"), "us");
  assert.equal(countryCodeFrom("United Kingdom"), "gb");
});
test("countryCodeFrom: thin countries the old table missed", () => {
  assert.equal(countryCodeFrom("Bulgaria"), "bg");
  assert.equal(countryCodeFrom("Sri Lanka"), "lk");
  assert.equal(countryCodeFrom("Estonia"), "ee");
});
test("countryCodeFrom: alias fallback", () => {
  assert.equal(countryCodeFrom("USA"), "us");
  assert.equal(countryCodeFrom("UK"), "gb");
});
test("countryCodeFrom: already a 2-letter code", () => {
  assert.equal(countryCodeFrom("kr"), "kr");
});
test("countryCodeFrom: unknown → null", () => {
  assert.equal(countryCodeFrom("Atlantis"), null);
  assert.equal(countryCodeFrom(""), null);
  assert.equal(countryCodeFrom(null), null);
});
test("nameKey: normalizes name + country", () => {
  assert.equal(nameKey("  KBS  Cool FM ", "kr"), "kbs cool fm|kr");
  assert.equal(nameKey("KBS Cool FM", "KR"), "kbs cool fm|kr");
});
test("nameKey: collapses internal whitespace + strips punctuation", () => {
  assert.equal(nameKey("Jazz   FM!!", "gb"), "jazz fm|gb");
});
test("nameKey: empty country still keys", () => {
  assert.equal(nameKey("Radio X", ""), "radio x|");
});
test("isKnown: membership against a Set", () => {
  const set = new Set([nameKey("Radio X", "fr")]);
  assert.equal(isKnown("Radio X", "fr", set), true);
  assert.equal(isKnown("Radio Y", "fr", set), false);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/lib/radio-garden.test.mjs`
Expected: FAIL — cannot find module `./radio-garden.mjs`.

- [ ] **Step 3: Implement the pure parts**

`tools/lib/radio-garden.mjs`:

```js
// tools/lib/radio-garden.mjs
// Shared radio.garden helpers (network + pure). The pure parts are unit-tested.

export const RG = "https://radio.garden";
export const UA = "kradio-importer/1.0 (+https://kradio.nvis.io)";

// ── pure: country name → ISO 3166-1 alpha-2 (lowercase) ────────────────
// Built by inverting Intl.DisplayNames over all alpha-2 codes (covers ~200
// countries), plus a small alias table for the names radio.garden uses that
// don't match Intl's canonical display name.
const ALIASES = {
  "usa": "us", "u.s.a.": "us", "u.s.": "us", "america": "us",
  "uk": "gb", "u.k.": "gb", "england": "gb", "great britain": "gb",
  "russia": "ru", "south korea": "kr", "north korea": "kp",
  "vietnam": "vn", "laos": "la", "syria": "sy", "iran": "ir",
  "moldova": "md", "bolivia": "bo", "venezuela": "ve", "tanzania": "tz",
  "czech republic": "cz", "czechia": "cz",
};

const NAME_TO_CODE = (() => {
  const map = new Map();
  let dn;
  try { dn = new Intl.DisplayNames(["en"], { type: "region" }); } catch { dn = null; }
  if (dn) {
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        let name;
        try { name = dn.of(code); } catch { name = null; }
        if (name && name !== code) map.set(name.toLowerCase(), code.toLowerCase());
      }
    }
  }
  for (const [k, v] of Object.entries(ALIASES)) map.set(k, v);
  return map;
})();

export function countryCodeFrom(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  if (NAME_TO_CODE.has(k)) return NAME_TO_CODE.get(k);
  if (/^[a-z]{2}$/.test(k)) return k;
  return null;
}

// ── pure: dedup key + membership ───────────────────────────────────────
export function nameKey(name, country) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")   // strip punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
  const c = String(country || "").toLowerCase().trim();
  return `${n}|${c}`;
}

export function isKnown(name, country, knownSet) {
  return knownSet.has(nameKey(name, country));
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/lib/radio-garden.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/lib/radio-garden.mjs tools/lib/radio-garden.test.mjs
git commit -m "🌱 feat: radio.garden lib — country mapper + dedup keys (tested)"
```

---

## Task 2: radio.garden lib — network functions

**Files:**
- Modify: `/Users/moon/Projects/claude/kradio/tools/lib/radio-garden.mjs`

Add the network helpers (smoke-tested live; no unit test — they're I/O).

- [ ] **Step 1: Append network functions to the lib**

Append to `tools/lib/radio-garden.mjs`:

```js
// ── network ────────────────────────────────────────────────────────────
async function getJSON(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`GET ${url} → HTTP ${r.status}`);
  return r.json();
}

// All places: [{ id, title, country, size, geo, url }]
export async function listPlaces() {
  const j = await getJSON(`${RG}/api/ara/content/places`);
  return j?.data?.list || j?.list || [];
}

// One place → [{ channelId, title }]
export async function expandPlaceItems(placeId) {
  const data = await getJSON(`${RG}/api/ara/content/page/${placeId}/channels`);
  const sections = data?.data?.content || data?.content || [];
  const out = [];
  const seen = new Set();
  for (const sec of sections) {
    for (const item of (sec.items || [])) {
      const url = item.page?.url || item.url || item.href || "";
      const m = url.match(/\/listen\/[^/]+\/([A-Za-z0-9_-]{6,})\/?$/);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ channelId: m[1], title: item.title || item.page?.title || "" });
    }
  }
  return out;
}

// Channel → broadcaster stream URL (follow the 302).
export async function resolveListenURL(channelId) {
  const u = `${RG}/api/ara/content/listen/${channelId}/channel.mp3?type=channel`;
  const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA } });
  if ([301, 302, 303, 307, 308].includes(r.status)) {
    const loc = r.headers.get("location");
    if (loc) return loc;
  }
  if (r.ok) return u;
  throw new Error(`listen redirect missing for ${channelId} (HTTP ${r.status})`);
}

// Channel metadata (name, place, country title).
export async function channelInfo(channelId) {
  const info = await getJSON(`${RG}/api/ara/content/channel/${channelId}`);
  const d = info?.data || info || {};
  return {
    name: d.title || d.subtitle || channelId,
    countryTitle: d.country?.title || null,
    city: d.place?.title || null,
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
```

- [ ] **Step 2: Live smoke test (places + one place's channels)**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/lib/radio-garden.mjs").then(async (rg) => {
  const places = await rg.listPlaces();
  console.log("places:", places.length);
  const seoul = places.find(p => /seoul/i.test(p.title));
  console.log("seoul:", seoul && (seoul.title + "/" + seoul.id + " size=" + seoul.size));
  const items = await rg.expandPlaceItems(seoul.id);
  console.log("seoul channels:", items.length, items.slice(0,3));
  if (items[0]) console.log("resolve[0]:", (await rg.resolveListenURL(items[0].channelId)).slice(0,60));
});'
```
Expected: `places: 12626`, a Seoul place, its channels with titles, and a resolved stream URL.

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/lib/radio-garden.mjs
git commit -m "🌱 feat: radio.garden lib — network helpers (listPlaces/expand/resolve/channelInfo)"
```

---

## Task 3: Refactor the existing CLI to use the lib (DRY)

**Files:**
- Modify: `/Users/moon/Projects/claude/kradio/tools/import-radio-garden.mjs`

Replace the now-duplicated helpers in the CLI with imports from the lib. Keep the CLI's behavior identical (it still imports by id/url with `--genre/--lang/--country/--proxy/--dry-run`).

- [ ] **Step 1: Re-point the CLI's helpers at the lib**

In `tools/import-radio-garden.mjs`:

1. After the existing imports, add:

```js
import {
  RG, UA, countryCodeFrom, resolveListenURL, channelInfo, sleep,
  expandPlaceItems,
} from "./lib/radio-garden.mjs";
```

2. Delete the now-duplicated local definitions of: the `RG` and `UA` consts, `getJSON` (if only used by the moved fns — keep a local copy if still referenced elsewhere), `resolveListenURL`, `COUNTRY_NAME_TO_CODE` + `countryCodeFrom`, `expandPlace`, and the local `sleep`. Replace the body of `importChannel` to use the lib's `channelInfo` + `resolveListenURL`:

```js
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
```

3. Replace the place-expansion call site (was `expandPlace(ref.id)` returning ids) with the lib's `expandPlaceItems`, taking `.channelId`:

```js
      try {
        const items = await expandPlaceItems(ref.id);
        const ids = items.map((it) => it.channelId);
        console.log(`place ${ref.id} → ${ids.length} channel(s)`);
        channelIds.push(...ids);
      } catch (e) {
        console.warn(`! place ${ref.id}: ${e.message}`);
      }
```

- [ ] **Step 2: Verify the CLI still works (help + 1-channel dry-run)**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-radio-garden.mjs --help >/dev/null && echo "help OK"
# pick a real Seoul channel id and dry-run it (no write)
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/lib/radio-garden.mjs").then(async (rg)=>{
  const places=await rg.listPlaces(); const s=places.find(p=>/seoul/i.test(p.title));
  const items=await rg.expandPlaceItems(s.id);
  console.log(items[0].channelId);
});' > /tmp/cid.txt
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-radio-garden.mjs --dry-run --country kr "$(cat /tmp/cid.txt)" 2>&1 | tail -8
rm -f /tmp/cid.txt
```
Expected: `help OK`, and the dry-run prints one `+ <name> [kr · Seoul]` style line and a `would add 1 entry` (or `url dup` if already in catalogue — both prove the refactored CLI runs).

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/import-radio-garden.mjs
git commit -m "♻️ refactor: import-radio-garden uses shared lib (DRY, behavior unchanged)"
git push
```

---

## Task 4: new-only orchestrator

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/import-rg-new.mjs`

- [ ] **Step 1: Write the orchestrator**

`tools/import-rg-new.mjs`:

```js
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
```

- [ ] **Step 2: Dry-run on two thin countries (cheap, no writes)**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-rg-new.mjs --countries kr,jp --max-resolve 50 --dry-run 2>&1 | tail -12
```
Expected: a summary like `scanned places: N, name-dupes skipped: M, resolved: X, NET-NEW: Y`. Most channels should be name-dupes (catalogue came from radio.garden); a handful may be net-new. Nothing written.

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/import-rg-new.mjs
git commit -m "🌱 feat: radio.garden new-only orchestrator (two-stage name+URL dedup)"
git push
```

---

## Task 5: Run it on PR #1's branch + update the PR

This runs the real top-up and folds it into PR #1 (which already has the RB import). Done on the `bot/station-import-first` branch.

- [ ] **Step 1: Check out PR #1's branch**

```bash
cd /Users/moon/Projects/claude/kradio
git fetch origin 2>&1 | tail -1
git checkout bot/station-import-first
git log --oneline -1
```
Expected: on `bot/station-import-first`, HEAD is the "first Radio Browser import" commit.

- [ ] **Step 2: Run the new-only import (all countries, capped)**

The tool reads the branch's `stations.json` (already 48,375 with RB), so it dedups against RB's additions too. Run in the background (place scan + resolves take a while):

`cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-rg-new.mjs --max-resolve 3000`
Expected on completion: summary with NET-NEW count; writes `tools/rg-candidates.json`. (Most channels are name-dupes → few resolves.)

- [ ] **Step 3: Probe → drop-dead → enrich → merge → index**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs tools/rg-candidates.json --out tools/probe-report.candidates.json --concurrency 40
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/drop-dead-candidates.mjs --candidates tools/rg-candidates.json --report tools/probe-report.candidates.json
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/enrich-stations.mjs tools/rg-candidates.json --in-place
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/merge-stations.mjs stations.json tools/rg-candidates.json --in-place
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/build-index.mjs
```
Expected: each prints its summary; `stations.json` grows by the (post-dead) net-new count; index rebuilt.

- [ ] **Step 4: Sanity-check**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const a=require("./stations.json");
console.log("catalogue:", a.length);
console.log("bad url:", a.filter(s=>!s.url||!/^https?:/i.test(s.url)).length);
const seen=new Set(); let d=0; for(const s of a){const k=(s.url||"").trim().toLowerCase(); if(seen.has(k))d++; else seen.add(k);} console.log("dup urls:", d);'
git --no-pager diff --stat stations.json stations.index.json | tail -3
```
Expected: catalogue grew by the RG net-new; `bad url` 0; `dup urls` 0.

- [ ] **Step 5: Commit + push (updates PR #1)**

```bash
cd /Users/moon/Projects/claude/kradio
git add stations.json stations.index.json
git commit -m "📡 data: radio.garden new-only top-up (net-new delta)"
git push
```
Expected: push to `bot/station-import-first`; **PR #1 now shows RB + radio.garden** combined. (No featured changes from radio.garden — by design.)

- [ ] **Step 6: Return to main**

```bash
cd /Users/moon/Projects/claude/kradio
git checkout main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Two-stage dedup (name pre-filter → resolve → URL dedup) | Task 4 (orchestrator), Task 1 (`nameKey`/`isKnown`) |
| Avoid resolving ~38k dupes | Task 4 Stage 1 (name skip before resolve) |
| `tools/lib/radio-garden.mjs` extracted | Tasks 1 (pure), 2 (network) |
| `countryCodeFrom` upgrade (Intl inversion, ~200 countries) | Task 1 |
| Refactor existing CLI to use lib (DRY) | Task 3 |
| `import-rg-new.mjs` + `--max-resolve` cap + `--countries` | Task 4 |
| Reuse probe→drop-dead→enrich→merge→index | Task 5 |
| Into PR #1 (bot/station-import-first) | Task 5 |
| No featured changes from radio.garden | Task 4 (only writes rg-candidates / stations.json; never touches featured) |
| Field mapping (title/url/country/city; genre&lang via enrich) | Task 4 |
| `rg-candidates.json` gitignored | already ignored (added in Channel B) |
| Pure-tested: countryCodeFrom, nameKey, isKnown | Task 1 |

**Type / name consistency:**
- `countryCodeFrom`, `nameKey`, `isKnown` exported from lib (Task 1), used in CLI (Task 3) + orchestrator (Task 4) ✓
- `listPlaces`, `expandPlaceItems` (returns `{channelId,title}`), `resolveListenURL`, `channelInfo`, `sleep` exported (Task 2), used in Task 3 (CLI) + Task 4 ✓
- `expandPlaceItems` returns `{channelId,title}` — CLI maps `.channelId` (Task 3), orchestrator reads `.title`/`.channelId` (Task 4) ✓
- `tools/rg-candidates.json` + `tools/probe-report.candidates.json` consistent with `drop-dead-candidates.mjs` flags (Task 5) ✓
- `merge-stations.mjs <base> <add> --in-place` matches its CLI (verified earlier) ✓
- `nameKey(name,country)` signature identical in lib def (Task 1), CLI is unaffected, orchestrator calls (Task 4) ✓

**Placeholder scan:** No TBD/"similar to". Task 3 Step 1 instruction "keep a local copy if still referenced elsewhere" refers to `getJSON` — concrete conditional, the engineer checks usage; the lib also exports nothing named `getJSON` (kept private), so the CLI either drops it or keeps its own — not a dangling reference. Every code step has complete code.

**One flagged risk:** Task 3 (CLI refactor) is the only change to existing working code; Step 2 re-verifies it (`--help` + live 1-channel dry-run) before commit. If the refactor misbehaves, fix before committing — the new-only tool (Task 4) does not depend on the CLI, so Task 4/5 can proceed even if Task 3 is deferred.

Plan is clean.

---

## Execution Handoff

Plan saved to `/Users/moon/Projects/claude/kradio/docs/superpowers/plans/2026-06-06-radio-garden-new-only.md`.

Two execution options:

1. **Subagent-Driven** — fresh subagent for Tasks 1–4 (lib/tool/tests + refactor), review between; Task 5 (the run + PR update) stays in the main session.
2. **Inline Execution (recommended here)** — run here with checkpoints; fits because Task 5 runs the import + updates PR #1 directly, and the earlier Channel B work is fresh in context.

Which approach?