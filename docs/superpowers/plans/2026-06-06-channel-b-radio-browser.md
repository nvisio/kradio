# Channel B — Radio Browser Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monthly, automatically pull popular stations per country from the Radio Browser API, add net-new ones to `stations.json` and union the top-voted ones into `featured/{cc}.json`, all behind a human-reviewed PR.

**Architecture:** Dependency-free Node tools in `kradio/tools/`: a thin RB API client (mirror discovery + per-country fetch), pure map/quality-filter and pure featured-union modules (TDD'd with `node:test`), an orchestrator, and a tiny dead-candidate filter. A monthly GitHub Action chains them with the existing `probe-streams`/`enrich-stations`/`merge-stations`/`build-index` tools and opens a PR — never auto-merging the catalogue.

**Tech Stack:** Node ≥20 built-ins (`node:test`, `fetch`, DNS via `node:dns/promises`) — no new deps; GitHub Actions (monthly cron); `peter-evans/create-pull-request` for the PR.

**Repo:** `/Users/moon/Projects/claude/kradio` → `nvisio/kradio`

**Spec:** `docs/superpowers/specs/2026-06-06-channel-b-radio-browser-design.md`

**Node:** prefix `node` commands with `PATH="/usr/local/opt/node@22/bin:$PATH"` (v22).

**Verified API facts (from research):** base `https://<mirror>` discovered via `GET https://all.api.radio-browser.info/json/servers` → `[{ip,name}]`; fetch `GET /json/stations/search?countrycode={CC}&order=votes&reverse=true&hidebroken=true&limit={K}`; `countrycode` is UPPERCASE alpha-2; use `url_resolved` for the stream; `tags`/`languagecodes` are comma-strings; UA `kradio/1.0` required.

---

## File Structure

```
tools/
├── rb-to-catalog.mjs            # NEW — pure: mapStation(), normUrl()
├── rb-to-catalog.test.mjs       # NEW — node:test
├── featured-merge.mjs           # NEW — pure: unionFeatured()
├── featured-merge.test.mjs      # NEW — node:test
├── lib/radio-browser.mjs        # NEW — API client (discoverMirror, fetchTopByCountry)
├── import-radio-browser.mjs     # NEW — orchestrator (fetch → map/filter → featured union + candidates)
├── drop-dead-candidates.mjs     # NEW — filter candidates by a probe report (reuses isPrunable)
├── probe-classify.mjs           # EXISTING (reused: isPrunable)
├── probe-streams.mjs            # EXISTING (reused)
├── enrich-stations.mjs          # EXISTING (reused)
├── merge-stations.mjs           # EXISTING (reused: URL dedup + compact format)
└── build-index.mjs              # EXISTING (reused)
.github/workflows/import-stations.yml   # NEW — monthly cron → PR
.gitignore                              # MODIFY — ignore rb-candidates + candidate report
```

---

## Task 1: Pure RB → catalogue mapping + filter

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/rb-to-catalog.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/rb-to-catalog.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/rb-to-catalog.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStation, normUrl } from "./rb-to-catalog.mjs";

function rb(over = {}) {
  return {
    name: "Jazz FM", url: "https://x/play.pls",
    url_resolved: "https://stream.example/jazz.mp3",
    countrycode: "GB", tags: "jazz,smooth jazz",
    languagecodes: "en", language: "english",
    state: "London", codec: "MP3", bitrate: 128,
    lastcheckok: 1, ssl_error: 0, ...over,
  };
}

test("maps a clean station", () => {
  const r = mapStation(rb());
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, {
    name: "Jazz FM",
    url: "https://stream.example/jazz.mp3",   // url_resolved, not url
    country: "gb",                              // lowercased
    genre: ["jazz", "smooth jazz"],            // tags split
    lang: ["en"],                              // languagecodes
    city: "London",                            // state best-effort
  });
});
test("prefers url_resolved; falls back to url when empty", () => {
  assert.equal(mapStation(rb({ url_resolved: "" })).entry.url, "https://x/play.pls");
});
test("lowercases country code", () => {
  assert.equal(mapStation(rb({ countrycode: "KR" })).entry.country, "kr");
});
test("splits comma tags + trims, drops empties", () => {
  assert.deepEqual(mapStation(rb({ tags: " rock , , pop " })).entry.genre, ["rock", "pop"]);
});
test("languagecodes preferred over language; lowercased", () => {
  assert.deepEqual(mapStation(rb({ languagecodes: "DE,EN", language: "german" })).entry.lang, ["de", "en"]);
});
test("falls back to language when languagecodes empty", () => {
  assert.deepEqual(mapStation(rb({ languagecodes: "", language: "Korean" })).entry.lang, ["korean"]);
});
test("rejects lastcheckok=0", () => {
  assert.equal(mapStation(rb({ lastcheckok: 0 })).ok, false);
});
test("rejects bitrate 0", () => {
  assert.equal(mapStation(rb({ bitrate: 0 })).ok, false);
});
test("rejects empty codec", () => {
  assert.equal(mapStation(rb({ codec: "" })).ok, false);
});
test("rejects non-http url", () => {
  assert.equal(mapStation(rb({ url_resolved: "rtmp://x/y" })).ok, false);
});
test("rejects empty url (both fields)", () => {
  assert.equal(mapStation(rb({ url_resolved: "", url: "" })).ok, false);
});
test("does NOT reject on ssl_error=1 (TLS != dead)", () => {
  assert.equal(mapStation(rb({ ssl_error: 1 })).ok, true);
});
test("normUrl lowercases, trims, strips trailing slash", () => {
  assert.equal(normUrl("  HTTPS://A.Com/Stream/ "), "https://a.com/stream");
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/rb-to-catalog.test.mjs`
Expected: FAIL — cannot find module `./rb-to-catalog.mjs`.

- [ ] **Step 3: Implement**

`tools/rb-to-catalog.mjs`:

```js
// tools/rb-to-catalog.mjs
// Pure mapping + quality filter: Radio Browser station → catalogue entry.
// No network. Unit-tested.

export function normUrl(u) {
  return (u || "").trim().toLowerCase().replace(/\/+$/, "");
}

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// rb: a Radio Browser station object.
// Returns { ok, reason?, entry } — entry is {name,url,country,genre,lang,city}.
export function mapStation(rb) {
  const url = (rb.url_resolved && rb.url_resolved.trim()) || (rb.url || "").trim();
  const reasons = [];
  if (rb.lastcheckok !== 1) reasons.push("lastcheckok");
  if (!(Number(rb.bitrate) > 0)) reasons.push("bitrate");
  if (!String(rb.codec || "").trim()) reasons.push("codec");
  if (!url) reasons.push("no_url");
  else if (!/^https?:\/\//i.test(url)) reasons.push("bad_scheme");
  // NOTE: ssl_error is deliberately NOT a reject reason — TLS != dead.

  const langs = splitCsv(rb.languagecodes).length
    ? splitCsv(rb.languagecodes)
    : splitCsv(rb.language);

  const entry = {
    name: String(rb.name || "").trim(),
    url,
    country: String(rb.countrycode || "").trim().toLowerCase(),
    genre: splitCsv(rb.tags).map((t) => t.toLowerCase()),
    lang: langs.map((l) => l.toLowerCase()),
    city: String(rb.state || "").trim(),
  };
  if (!entry.name) reasons.push("no_name");
  if (!entry.country) reasons.push("no_country");

  return reasons.length ? { ok: false, reason: reasons.join(","), entry } : { ok: true, entry };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/rb-to-catalog.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/rb-to-catalog.mjs tools/rb-to-catalog.test.mjs
git commit -m "🔌 feat: pure Radio Browser → catalogue mapper + quality filter (tested)"
```

---

## Task 2: Pure featured union

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/featured-merge.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/featured-merge.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/featured-merge.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { unionFeatured } from "./featured-merge.mjs";

test("appends new incoming after existing, dedup by url", () => {
  const existing = [{ name: "A", url: "https://a" }];
  const incoming = [{ name: "A2", url: "https://a" }, { name: "B", url: "https://b" }];
  assert.deepEqual(unionFeatured(existing, incoming, 10),
    [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }]);
});
test("preserves existing order and flags", () => {
  const existing = [{ name: "Geo", url: "https://g", availability: "geo_restricted", countries: ["ro"] }];
  const incoming = [{ name: "New", url: "https://n" }];
  const out = unionFeatured(existing, incoming, 10);
  assert.deepEqual(out[0], { name: "Geo", url: "https://g", availability: "geo_restricted", countries: ["ro"] });
  assert.equal(out[1].name, "New");
});
test("dedup is case/trailing-slash insensitive", () => {
  const existing = [{ name: "A", url: "https://a.com/s/" }];
  const incoming = [{ name: "A2", url: "HTTPS://A.COM/s" }];
  assert.equal(unionFeatured(existing, incoming, 10).length, 1);
});
test("caps growth but never truncates existing", () => {
  const existing = [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }];
  const incoming = [{ name: "C", url: "https://c" }, { name: "D", url: "https://d" }];
  assert.deepEqual(unionFeatured(existing, incoming, 3).map((e) => e.name), ["A", "B", "C"]);
});
test("existing already at/over cap → no append", () => {
  const existing = [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }];
  const incoming = [{ name: "C", url: "https://c" }];
  assert.deepEqual(unionFeatured(existing, incoming, 2).map((e) => e.name), ["A", "B"]);
});
test("incoming entries are reduced to {name,url}", () => {
  const out = unionFeatured([], [{ name: "X", url: "https://x", votes: 5, tags: "pop" }], 10);
  assert.deepEqual(out, [{ name: "X", url: "https://x" }]);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/featured-merge.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`tools/featured-merge.mjs`:

```js
// tools/featured-merge.mjs
// Pure union of existing (hand-curated) featured entries with incoming RB
// entries: keep all existing in order (preserving any availability flags),
// append new incoming (reduced to {name,url}) not already present, up to cap.
// Never truncates existing curation.

import { normUrl } from "./rb-to-catalog.mjs";

export function unionFeatured(existing, incoming, cap) {
  const out = existing.slice();
  const seen = new Set(out.map((e) => normUrl(e.url)));
  for (const e of incoming) {
    if (out.length >= cap) break;
    const k = normUrl(e.url);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: e.name, url: e.url });
  }
  return out;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/featured-merge.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/featured-merge.mjs tools/featured-merge.test.mjs
git commit -m "🔀 feat: pure featured union (preserve curation, append new, cap) (tested)"
```

---

## Task 3: Radio Browser API client

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/lib/radio-browser.mjs`

Thin network client; verified by a live smoke test in Step 2 (no unit test — it's I/O).

- [ ] **Step 1: Write the client**

`tools/lib/radio-browser.mjs`:

```js
// tools/lib/radio-browser.mjs
// Minimal Radio Browser API client: discover a mirror, fetch top stations
// per country by votes. Sends a descriptive User-Agent (the one real ask).

const UA = "kradio/1.0 (+https://kradio.nvis.io)";
const DISCOVERY = "https://all.api.radio-browser.info/json/servers";

async function getJSON(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Returns an ordered list of mirror base URLs (https://<name>), discovery host last.
export async function discoverMirrors() {
  try {
    const servers = await getJSON(DISCOVERY);
    const names = [...new Set((servers || []).map((s) => s.name).filter(Boolean))];
    // shuffle by a fixed-ish rotation (avoid Math.random for determinism in CI logs)
    const bases = names.map((n) => `https://${n}`);
    if (bases.length) return bases;
  } catch { /* fall through */ }
  return ["https://de1.api.radio-browser.info", "https://all.api.radio-browser.info"];
}

// Fetch top stations for one UPPERCASE alpha-2 country code, ordered by votes.
// Tries each mirror until one succeeds.
export async function fetchTopByCountry(mirrors, cc, { limit = 500 } = {}) {
  const qs = new URLSearchParams({
    countrycode: cc.toUpperCase(),
    order: "votes",
    reverse: "true",
    hidebroken: "true",
    limit: String(limit),
    offset: "0",
  });
  let lastErr;
  for (const base of mirrors) {
    try {
      return await getJSON(`${base}/json/stations/search?${qs}`);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`all mirrors failed for ${cc}: ${lastErr?.message || "unknown"}`);
}
```

- [ ] **Step 2: Live smoke test**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/lib/radio-browser.mjs").then(async ({discoverMirrors, fetchTopByCountry}) => {
  const m = await discoverMirrors();
  console.log("mirrors:", m.slice(0,3));
  const s = await fetchTopByCountry(m, "KR", { limit: 3 });
  console.log("KR top3:", s.map(x => x.name + " | votes=" + x.votes + " | " + (x.url_resolved||x.url).slice(0,40)));
});'
```
Expected: prints ≥1 mirror base and 3 Korean stations with vote counts + resolved URLs. (If discovery is down, it still falls back to `de1`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/lib/radio-browser.mjs
git commit -m "📡 feat: Radio Browser API client (mirror discovery + top-by-country)"
```

---

## Task 4: drop-dead-candidates filter

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/drop-dead-candidates.mjs`

Reuses the tested `isPrunable`. Thin glue; correctness of "what's dead" already covered by `probe-classify.test.mjs`.

- [ ] **Step 1: Write it**

`tools/drop-dead-candidates.mjs`:

```js
#!/usr/bin/env node
// tools/drop-dead-candidates.mjs
// Drop candidate stations that a probe report marks hard-dead (reuses isPrunable).
//   node tools/drop-dead-candidates.mjs --candidates tools/rb-candidates.json \
//        --report tools/probe-report.candidates.json [--out tools/rb-candidates.json]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrunable } from "./probe-classify.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const candPath = arg("--candidates", "tools/rb-candidates.json");
  const reportPath = arg("--report", "tools/probe-report.candidates.json");
  const outPath = arg("--out", candPath);

  const candidates = JSON.parse(await readFile(resolve(candPath), "utf8"));
  const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  const deadUrls = new Set(report.filter(isPrunable).map((r) => normUrl(r.url)));

  const kept = candidates.filter((c) => !deadUrls.has(normUrl(c.url)));
  await writeFile(resolve(outPath), JSON.stringify(kept) + "\n", "utf8");
  console.error(`candidates ${candidates.length} → ${kept.length} (dropped ${candidates.length - kept.length} hard-dead)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify with a tiny fixture**

```bash
cd /Users/moon/Projects/claude/kradio
echo '[{"name":"Live","url":"https://live/x"},{"name":"Dead","url":"https://dead/y"}]' > /tmp/cand.json
echo '[{"url":"https://dead/y","reachability":"dead"},{"url":"https://live/x","reachability":"reachable"}]' > /tmp/rep.json
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/drop-dead-candidates.mjs --candidates /tmp/cand.json --report /tmp/rep.json --out /tmp/out.json
PATH="/usr/local/opt/node@22/bin:$PATH" node -e 'console.log(JSON.stringify(require("/tmp/out.json")))'
rm -f /tmp/cand.json /tmp/rep.json /tmp/out.json
```
Expected: prints `[{"name":"Live","url":"https://live/x"}]` (the dead one dropped).

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/drop-dead-candidates.mjs
git commit -m "🧹 feat: drop hard-dead RB candidates by probe report"
```

---

## Task 5: Orchestrator

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/import-radio-browser.mjs`
- Modify: `/Users/moon/Projects/claude/kradio/.gitignore`

The orchestrator glues the pure modules + client. Its pure parts are already tested (Tasks 1–2); this task verifies the wiring with a small live run.

- [ ] **Step 1: Broaden .gitignore**

Append to `.gitignore`:

```
tools/rb-candidates.json
```
(`tools/probe-report*.json` is already ignored and covers `probe-report.candidates.json`.)

- [ ] **Step 2: Write the orchestrator**

`tools/import-radio-browser.mjs`:

```js
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

    // (a) featured union (top by votes order, which is how RB returned them)
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
```

- [ ] **Step 3: Dry-run on two countries (no writes)**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-radio-browser.mjs --countries kr,de --limit 50 --dry-run
```
Expected: per-country lines like `kr: fetched 50, ok N, rejected M, net-new X, featured A→B` and a total; no files modified (confirm with `git status --short featured/`).

- [ ] **Step 4: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/import-radio-browser.mjs .gitignore
git commit -m "🛰️ feat: Radio Browser import orchestrator (featured union + net-new candidates)"
```

---

## Task 6: Monthly GitHub Action → PR

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/.github/workflows/import-stations.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/import-stations.yml`:

```yaml
name: Monthly station import (Radio Browser)

on:
  schedule:
    - cron: "23 4 1 * *"      # 1st of month, 04:23 UTC
  workflow_dispatch:
    inputs:
      limit:
        description: "Per-country fetch limit"
        default: "500"
      featured_cap:
        description: "Max featured entries per country"
        default: "50"

permissions:
  contents: write
  pull-requests: write

concurrency:
  group: station-import
  cancel-in-progress: false

jobs:
  import:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Import from Radio Browser (featured union + candidates)
        run: node tools/import-radio-browser.mjs --limit "${{ github.event.inputs.limit || '500' }}" --featured-cap "${{ github.event.inputs.featured_cap || '50' }}"

      - name: Probe net-new candidates
        run: node tools/probe-streams.mjs tools/rb-candidates.json --out tools/probe-report.candidates.json --concurrency 40 --timeout 8000

      - name: Drop hard-dead candidates
        run: node tools/drop-dead-candidates.mjs

      - name: Enrich genre/lang
        run: node tools/enrich-stations.mjs tools/rb-candidates.json --in-place

      - name: Merge net-new into catalogue
        run: node tools/merge-stations.mjs stations.json tools/rb-candidates.json --in-place

      - name: Rebuild index
        run: node tools/build-index.mjs

      - name: Open pull request
        uses: peter-evans/create-pull-request@v6
        with:
          branch: bot/station-import
          title: "📡 Monthly station import (Radio Browser)"
          commit-message: "📡 data: monthly Radio Browser import (catalogue + featured)"
          body: |
            Automated monthly import from the Radio Browser API.
            - `stations.json` / `stations.index.json`: net-new stations (probed, hard-dead dropped, deduped)
            - `featured/*.json`: top-voted unioned in (existing curation preserved)

            Review the diff before merging. Health/availability are handled separately by the weekly pipeline.
          add-paths: |
            stations.json
            stations.index.json
            featured/*.json
```

Notes for the implementer:
- `peter-evans/create-pull-request` only stages `add-paths`, so the gitignored `tools/rb-candidates.json` / `probe-report.candidates.json` never get committed.
- If org branch-protection blocks the bot, the PR still opens; a human merges.
- `enrich-stations.mjs` accepts a path + `--in-place` (per its `--help`); confirm the flag name when wiring (the repo's enrich tool uses `--in-place`).

- [ ] **Step 2: Lint the YAML**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const s=require("fs").readFileSync(".github/workflows/import-stations.yml","utf8");
for (const k of ["workflow_dispatch","contents: write","pull-requests: write","import-radio-browser.mjs","probe-streams.mjs","drop-dead-candidates.mjs","merge-stations.mjs","build-index.mjs","create-pull-request"]) {
  if (!s.includes(k)) throw new Error("missing: "+k);
}
console.log("workflow structure OK");'
```
Expected: `workflow structure OK`.

- [ ] **Step 3: Verify enrich-stations CLI accepts the path + --in-place**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/enrich-stations.mjs --help 2>&1 | grep -i "in-place" || echo "CHECK: confirm enrich in-place flag"
```
Expected: shows the `--in-place` option. If the flag differs, update the workflow's "Enrich" step to match before committing.

- [ ] **Step 4: Commit + push**

```bash
cd /Users/moon/Projects/claude/kradio
git add .github/workflows/import-stations.yml
git commit -m "⚙️ ci: monthly Radio Browser import workflow (→ PR)"
git push
```

---

## Task 7: First real run (local) → PR by hand

This produces the first real import so you can eyeball quality before trusting the monthly Action. Run locally; open the PR manually (mirrors what CI will do).

- [ ] **Step 1: Branch**

```bash
cd /Users/moon/Projects/claude/kradio
git checkout -b bot/station-import-first
```

- [ ] **Step 2: Import (all featured countries)**

Run (background — many countries × fetch; tens of minutes):
`cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/import-radio-browser.mjs --limit 500 --featured-cap 50`
Expected: per-country summary; writes `featured/*.json` updates + `tools/rb-candidates.json`.

- [ ] **Step 3: Probe + drop dead + enrich + merge + index**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs tools/rb-candidates.json --out tools/probe-report.candidates.json --concurrency 40
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/drop-dead-candidates.mjs
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/enrich-stations.mjs tools/rb-candidates.json --in-place
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/merge-stations.mjs stations.json tools/rb-candidates.json --in-place
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/build-index.mjs
```
Expected: each step prints its summary; `stations.json` grows; index rebuilt.

- [ ] **Step 4: Sanity-check the diff**

```bash
cd /Users/moon/Projects/claude/kradio
git --no-pager diff --stat stations.json stations.index.json featured/ | tail -20
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const a=require("./stations.json"); console.log("catalogue now:", a.length);
const bad=a.filter(s=>!s.url||!/^https?:/i.test(s.url)).length; console.log("entries with bad url:", bad);'
```
Expected: catalogue count increased by the net-new count; `bad url` is 0; featured files show appended entries only (existing preserved).

- [ ] **Step 5: Commit + push + open PR**

```bash
cd /Users/moon/Projects/claude/kradio
git add stations.json stations.index.json featured/*.json
git commit -m "📡 data: first Radio Browser import (catalogue + featured)"
git push -u origin bot/station-import-first
gh pr create -R nvisio/kradio --title "📡 First Radio Browser import" \
  --body "First Channel B import. Review catalogue additions + featured unions before merge."
```
Expected: PR URL printed. Review the diff in the PR, then merge when satisfied. (Do NOT merge blindly — this is the human gate.)

---

## Task 8: Document the intake

**Files:**
- Modify: `/Users/moon/Projects/claude/kradio/featured/README.md`

- [ ] **Step 1: Append an intake section**

Add to the end of `featured/README.md`:

```markdown
## Station intake (Channel B — Radio Browser)

Monthly, `.github/workflows/import-stations.yml` runs
`tools/import-radio-browser.mjs`: for each country it fetches the most-voted
stations from the Radio Browser API (`order=votes&hidebroken=true`), maps them
to our schema, unions the top ones into `featured/{cc}.json` (existing curation
preserved), and collects net-new stations. The Action then probes the net-new
candidates (`probe-streams` → `drop-dead-candidates`), enriches genre/lang,
merges them into `stations.json` (URL-deduped) via `merge-stations`, rebuilds
the index, and **opens a PR** — catalogue changes are never auto-merged.

- Stream URL = RB `url_resolved`; country = `countrycode` (lowercased);
  genre = `tags`; lang = `languagecodes`. Dedup is by normalized URL.
- Data is CC0; requests send a `kradio/1.0` User-Agent.
- **radio.garden** stays a manual source (`tools/import-radio-garden.mjs`) that
  funnels through the same `merge-stations` → `build-index` path.

See `docs/superpowers/specs/2026-06-06-channel-b-radio-browser-design.md`.
```

- [ ] **Step 2: Commit + push**

```bash
cd /Users/moon/Projects/claude/kradio
git add featured/README.md
git commit -m "📚 docs: document Channel B Radio Browser intake"
git push
```

---

## Task 9: Validate the Action (manual dispatch)

- [ ] **Step 1: Dispatch with a small limit**

After Task 6 is pushed to `main`:

```bash
gh workflow run "Monthly station import (Radio Browser)" -R nvisio/kradio -f limit=50 -f featured_cap=50
sleep 8
gh run list -R nvisio/kradio --workflow "Monthly station import (Radio Browser)" -L 2
```
Expected: a run appears `in_progress`. Let it finish; confirm it opens (or updates) the `bot/station-import` PR. Review that PR's diff. (Using `limit=50` keeps the validation run light.)

- [ ] **Step 2: Confirm artifacts not committed**

In the resulting PR, verify `tools/rb-candidates.json` and `tools/probe-report.candidates.json` are **absent** from the diff (gitignored) — only `stations.json`, `stations.index.json`, `featured/*.json` appear.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| RB fetch endpoint (votes, hidebroken, countrycode upper) | Task 3 |
| Field mapping (url_resolved, lowercase cc, tags/lang split, state→city) | Task 1 |
| Quality filter (lastcheckok, bitrate, codec, url; ssl_error not dead) | Task 1 |
| Stateless URL dedup vs stations.json | Tasks 1 (`normUrl`), 5 |
| Featured union (preserve curation, append, cap) | Task 2, applied in Task 5 |
| Probe net-new + drop hard-dead | Tasks 4, 6, 7 |
| Enrich + merge (dedup+compact) + index | Tasks 6, 7 (reused tools) |
| Monthly Action → PR, never auto-merge | Task 6 |
| Artifacts gitignored | Tasks 5 (`.gitignore`), 9 |
| UA + mirror discovery + failover | Task 3 |
| radio.garden stays manual | Task 8 (doc); not automated (by design) |
| First run human-gated | Task 7 |
| Documentation | Task 8 |

**Type / name consistency:**
- `normUrl` exported from `rb-to-catalog.mjs` (Task 1), imported by `featured-merge.mjs` (Task 2), `drop-dead-candidates.mjs` (Task 4 uses its own local normUrl — consistent lowercase/trim; acceptable), `import-radio-browser.mjs` (Task 5) ✓
- `mapStation` returns `{ ok, reason?, entry }`; consumers (Task 5) read `.ok`/`.entry` ✓
- `unionFeatured(existing, incoming, cap)` signature identical in Task 2 def and Task 5 call ✓
- `discoverMirrors()` / `fetchTopByCountry(mirrors, cc, {limit})` defined in Task 3, called in Task 5 ✓
- `isPrunable` reused from `probe-classify.mjs` (Task 4) — exists from prior work ✓
- candidate file path `tools/rb-candidates.json` + report `tools/probe-report.candidates.json` consistent across Tasks 4, 5, 6, 7 ✓
- `merge-stations.mjs` flags (`<base> <add> --in-place`) match its actual CLI (verified in earlier exploration) ✓

**Placeholder scan:** No TBD/"similar to". One explicit verification step (Task 6 Step 3) confirms the `enrich-stations` flag name rather than assuming — that's a guard, not a placeholder. Every code step has complete code.

**One flagged assumption:** Task 4's `drop-dead-candidates.mjs` defines a local `normUrl` rather than importing the one from `rb-to-catalog.mjs`, to keep it dependency-light; both implement the same lowercase+trim. Acceptable (no behavioral divergence for the dead-set membership test).

Plan is clean.

---

## Execution Handoff

Plan saved to `/Users/moon/Projects/claude/kradio/docs/superpowers/plans/2026-06-06-channel-b-radio-browser.md`.

Two execution options:

1. **Subagent-Driven (recommended for Tasks 1–6)** — fresh subagent per tool task, review between. Tasks 7 & 9 (the real import run + Action dispatch + PR review) stay in the main session.
2. **Inline Execution** — run here with checkpoints; fits "verify and populate" since I run the import + open the PR directly.

Which approach?