# Stream Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal stream-availability model to the catalogue (default global, flag only exceptions), verify it by actually probing streams, conservatively prune hard-dead links from the 37k catalogue, and have the iOS app geo-filter the featured shelf.

**Architecture:** Deterministic, dependency-free Node tools in `kradio/tools/` own reachability (dead/reachable/unknown) for both the featured set and the full catalogue. A small LLM Workflow judges geo/event for the handful of featured *candidates* (probe `geoHint` 403/451, a tiny conservative domain prior, or event keywords) with an adversarial refute pass; ambiguous verdicts go to a human-confirm list. The iOS `RemoteStationCatalog` decodes the new optional fields and hides stations the user can't play.

**Tech Stack:** Node ≥20 (built-in `node:test`, `fetch`, `AbortController`) — no new deps; the Workflow tool for LLM classification; Swift/SwiftUI (pure logic TDD'd via the `swift` CLI, since kbscong has no XCTest target).

**Repos:**
- Public: `/Users/moon/Projects/claude/kradio` → `nvisio/kradio`
- iOS (private): `/Users/moon/Projects/claude/kbscong`

**Spec:** `docs/superpowers/specs/2026-06-06-stream-availability-design.md`

**Node:** use `/usr/local/opt/node@22/bin/node` (v22) for all `node` commands below; the default `node` is v21 and works too, but pin v22 for consistency. Shorthand used in commands: prefix `PATH="/usr/local/opt/node@22/bin:$PATH"`.

---

## File Structure

### `nvisio/kradio`
```
tools/
├── probe-classify.mjs            # NEW — pure: classifyReachability(), isPrunable()
├── probe-classify.test.mjs       # NEW — node:test
├── probe-streams.mjs             # NEW — network probe harness → probe-report.*.json
├── geo-prior.mjs                 # NEW — pure: geoPriorForUrl(), selectGeoCandidates()
├── geo-prior.test.mjs            # NEW — node:test
├── apply-availability.mjs        # NEW — pure: mergeVerdict() + harness writes featured/
├── apply-availability.test.mjs   # NEW — node:test
├── prune-dead.mjs                # NEW — conservative stations.json prune + reindex
├── availability-classify.workflow.js  # NEW — Workflow script (LLM classify + adversarial)
├── probe-report.featured.json    # ARTIFACT (gitignored)
├── probe-report.full.json        # ARTIFACT (gitignored)
└── availability-review.json      # human-confirm list (committed — audit trail)
featured/
├── *.json                        # exception entries annotated by apply-availability
└── README.md                     # MODIFY — document new fields + StreamAvailability + radiko
.gitignore                        # MODIFY — probe-report*.json
docs/superpowers/{specs,plans}/…  # spec + this plan
```

### `kbscong`
```
Shared/RemoteStationCatalog.swift  # MODIFY — extend FeaturedEntry, add isHidden(), filter + radiko url-fallback
```

---

## Phase 1 — Probe tooling (deterministic, TDD)

### Task 1: Pure reachability classifier

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/probe-classify.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/probe-classify.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/probe-classify.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReachability, isPrunable } from "./probe-classify.mjs";

test("DNS NXDOMAIN → dead", () => {
  assert.deepEqual(classifyReachability({ errorCode: "ENOTFOUND" }),
    { reachability: "dead", geoHint: false, signal: "ENOTFOUND" });
});
test("connection refused → dead", () => {
  assert.equal(classifyReachability({ errorCode: "ECONNREFUSED" }).reachability, "dead");
});
test("TLS cert error → dead", () => {
  assert.equal(classifyReachability({ errorCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }).reachability, "dead");
});
test("timeout → unknown (not dead)", () => {
  assert.equal(classifyReachability({ errorCode: "ETIMEDOUT" }).reachability, "unknown");
});
test("connection reset → unknown", () => {
  assert.equal(classifyReachability({ errorCode: "ECONNRESET" }).reachability, "unknown");
});
test("404 → dead", () => {
  assert.equal(classifyReachability({ status: 404 }).reachability, "dead");
});
test("410 → dead", () => {
  assert.equal(classifyReachability({ status: 410 }).reachability, "dead");
});
test("403 → unknown + geoHint", () => {
  const r = classifyReachability({ status: 403 });
  assert.equal(r.reachability, "unknown");
  assert.equal(r.geoHint, true);
});
test("451 → unknown + geoHint", () => {
  assert.equal(classifyReachability({ status: 451 }).geoHint, true);
});
test("200 audio/mpeg → reachable", () => {
  assert.equal(classifyReachability({ status: 200, contentType: "audio/mpeg" }).reachability, "reachable");
});
test("200 HLS playlist → reachable", () => {
  assert.equal(classifyReachability({ status: 206, contentType: "application/vnd.apple.mpegurl" }).reachability, "reachable");
});
test("200 text/html → unknown (bad content type)", () => {
  assert.equal(classifyReachability({ status: 200, contentType: "text/html" }).reachability, "unknown");
});
test("503 → unknown (kept, transient)", () => {
  assert.equal(classifyReachability({ status: 503 }).reachability, "unknown");
});
test("isPrunable: dead → true; unknown/reachable → false", () => {
  assert.equal(isPrunable({ reachability: "dead" }), true);
  assert.equal(isPrunable({ reachability: "unknown" }), false);   // covers 503, 403, timeout
  assert.equal(isPrunable({ reachability: "reachable" }), false);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/probe-classify.test.mjs`
Expected: FAIL — cannot find module `./probe-classify.mjs`.

- [ ] **Step 3: Implement**

`tools/probe-classify.mjs`:

```js
// tools/probe-classify.mjs
// Pure reachability classifier. No network, no side effects — unit-testable.
//
// reachability:
//   "dead"      — hard failure (DNS NXDOMAIN, conn refused, TLS invalid, 404, 410).
//                 By construction this is exactly the set safe to prune.
//   "reachable" — 2xx with an audio-ish content-type.
//   "unknown"   — everything else (timeout, reset, 5xx, 401/403/451, other 4xx,
//                 2xx non-audio). 403/451 set geoHint.

const AUDIO_TYPES = [
  "audio/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/ogg",
  "application/octet-stream",
];

const HARD_DEAD_ERRORS = new Set(["ENOTFOUND", "ECONNREFUSED"]);

function isTlsError(code) {
  return typeof code === "string" &&
    (code.includes("CERT") || code.includes("SSL") ||
     code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
     code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE");
}

export function classifyReachability({ status = null, contentType = null, errorCode = null } = {}) {
  if (errorCode) {
    if (HARD_DEAD_ERRORS.has(errorCode) || isTlsError(errorCode)) {
      return { reachability: "dead", geoHint: false, signal: errorCode };
    }
    return { reachability: "unknown", geoHint: false, signal: errorCode };
  }
  if (status === 404 || status === 410) {
    return { reachability: "dead", geoHint: false, signal: `http_${status}` };
  }
  if (status === 403 || status === 451) {
    return { reachability: "unknown", geoHint: true, signal: `http_${status}` };
  }
  if (status !== null && status >= 200 && status < 300) {
    const ct = (contentType || "").toLowerCase();
    const audio = AUDIO_TYPES.some((t) => ct.startsWith(t) || ct.includes(t));
    return audio
      ? { reachability: "reachable", geoHint: false, signal: "ok" }
      : { reachability: "unknown", geoHint: false, signal: "bad_content_type" };
  }
  return { reachability: "unknown", geoHint: false, signal: status ? `http_${status}` : "no_status" };
}

export function isPrunable(record) {
  return !!record && record.reachability === "dead";
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/probe-classify.test.mjs`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/probe-classify.mjs tools/probe-classify.test.mjs
git commit -m "🔬 feat: pure stream reachability classifier (tested)"
```

---

### Task 2: Probe harness

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/probe-streams.mjs`
- Modify: `/Users/moon/Projects/claude/kradio/.gitignore`

No new unit tests (network harness); the classifier it calls is already tested. Verified by a live smoke run in Step 3.

- [ ] **Step 1: Broaden .gitignore**

Replace the probe-report line in `.gitignore` so both report files are ignored. The file currently contains a block ending with `tools/probe-report.json`. Change that exact line:

`tools/probe-report.json`

to:

`tools/probe-report*.json`

- [ ] **Step 2: Write the harness**

`tools/probe-streams.mjs`:

```js
#!/usr/bin/env node
// tools/probe-streams.mjs
// Deterministic, LLM-free stream reachability probe. Writes a sidecar report;
// never touches featured/ or stations.json itself.
//
// Usage:
//   node tools/probe-streams.mjs --featured                       → tools/probe-report.featured.json
//   node tools/probe-streams.mjs stations.json                    → tools/probe-report.full.json
//   node tools/probe-streams.mjs <input> --out file --concurrency 40 --timeout 8000

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyReachability } from "./probe-classify.mjs";

function parseArgs(argv) {
  const o = { input: null, featured: false, out: null, concurrency: 20, timeout: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--featured") o.featured = true;
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--concurrency") o.concurrency = parseInt(argv[++i], 10);
    else if (a === "--timeout") o.timeout = parseInt(argv[++i], 10);
    else if (!o.input) o.input = a;
  }
  return o;
}

async function loadFeatured() {
  const dir = resolve("featured");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const cc = f.replace(/\.json$/i, "").toLowerCase();
    const arr = JSON.parse(await readFile(join(dir, f), "utf8"));
    for (const e of arr) out.push({ name: e.name, url: e.url, country: cc });
  }
  return out;
}

async function loadCatalog(path) {
  const arr = JSON.parse(await readFile(resolve(path), "utf8"));
  return arr.map((e) => ({ name: e.name, url: e.url, country: (e.country || "").toLowerCase() }));
}

async function probeOnce(url, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1", "User-Agent": "kradio-probe/1 (+https://kradio.nvis.io)" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    return { status: res.status, contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(t);
  }
}

async function probeOne(entry, timeout) {
  const base = { name: entry.name, url: entry.url, country: entry.country, checkedAt: new Date().toISOString() };
  if (!entry.url) {
    return { ...base, httpStatus: null, contentType: null, reachability: "unknown", geoHint: false, signal: "no_url" };
  }
  try {
    let r = await probeOnce(entry.url, timeout);
    if (r.status >= 500) {            // one retry on 5xx
      try { r = await probeOnce(entry.url, timeout); } catch { /* keep first */ }
    }
    const c = classifyReachability({ status: r.status, contentType: r.contentType });
    return { ...base, httpStatus: r.status, contentType: r.contentType, ...c };
  } catch (e) {
    const code = e?.cause?.code || (e?.name === "AbortError" ? "ETIMEDOUT" : e?.code) || "ERR";
    const c = classifyReachability({ errorCode: code });
    return { ...base, httpStatus: null, contentType: null, error: String(e?.message || e), ...c };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      if (++done % 100 === 0) process.stderr.write(`  probed ${done}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = args.featured ? await loadFeatured() : await loadCatalog(args.input);
  const out = args.out || (args.featured ? "tools/probe-report.featured.json" : "tools/probe-report.full.json");
  console.error(`probing ${items.length} streams (concurrency ${args.concurrency}, timeout ${args.timeout}ms)…`);
  const records = await pool(items, args.concurrency, (e) => probeOne(e, args.timeout));
  await writeFile(resolve(out), JSON.stringify(records, null, 0) + "\n", "utf8");
  const tally = records.reduce((m, r) => ((m[r.reachability] = (m[r.reachability] || 0) + 1), m), {});
  console.error(`wrote ${out} — ${JSON.stringify(tally)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Smoke-test on a 5-entry slice**

Run a tiny probe to confirm the harness works end to end (writes a throwaway report):

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/probe-classify.mjs").then(async ({classifyReachability}) => {
  const urls = JSON.parse(require("fs").readFileSync("featured/de.json")).slice(0,5);
  for (const e of urls) {
    try { const r = await fetch(e.url, {method:"GET", headers:{Range:"bytes=0-1"}}); console.log(r.status, (r.headers.get("content-type")||"").slice(0,30), e.name); }
    catch(err){ console.log("ERR", err.cause?.code||err.code, e.name); }
  }
});'
```
Expected: 5 lines, mostly `200`/`206` with `audio/...` content types (proves real streams resolve from this host). This validates `fetch`+`Range` works here before the full run.

- [ ] **Step 4: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/probe-streams.mjs .gitignore
git commit -m "🛰️ feat: deterministic stream probe harness (concurrent, sidecar report)"
```

---

### Task 3: Conservative dead-prune tool

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/prune-dead.mjs`

Reuses the already-tested `isPrunable`. The prune harness is thin; correctness of "what gets pruned" is guaranteed by Task 1's `isPrunable` tests (dead only; 5xx/403/timeout kept).

- [ ] **Step 1: Write the harness**

`tools/prune-dead.mjs`:

```js
#!/usr/bin/env node
// tools/prune-dead.mjs
// Conservatively remove hard-dead entries from stations.json, keyed by URL,
// using a probe report. Only reachability === "dead" (DNS/conn/TLS/404/410)
// is pruned; timeouts, 403, and 5xx are kept. Refuses to run on a suspiciously
// small report (guards against a truncated probe).
//
// Usage:
//   node tools/prune-dead.mjs [--report tools/probe-report.full.json] [--stations stations.json] [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrunable } from "./probe-classify.mjs";

const MIN_REPORT = 1000; // a real full-catalogue report has tens of thousands of rows

function parseArgs(argv) {
  const o = { report: "tools/probe-report.full.json", stations: "stations.json", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") o.report = argv[++i];
    else if (a === "--stations") o.stations = argv[++i];
    else if (a === "--dry-run") o.dryRun = true;
  }
  return o;
}

function compactArrayJSON(arr) {
  if (arr.length === 0) return "[]\n";
  return "[\n  " + arr.map((o) => JSON.stringify(o)).join(",\n  ") + "\n]\n";
}

const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await readFile(resolve(a.report), "utf8"));
  if (!Array.isArray(report) || report.length < MIN_REPORT) {
    throw new Error(`report ${a.report} has ${report.length} rows (< ${MIN_REPORT}); refusing to prune`);
  }
  const deadUrls = new Set(report.filter(isPrunable).map((r) => normUrl(r.url)).filter(Boolean));

  const stations = JSON.parse(await readFile(resolve(a.stations), "utf8"));
  const kept = stations.filter((s) => !deadUrls.has(normUrl(s.url)));
  const removed = stations.length - kept.length;

  console.error(`report rows: ${report.length}  hard-dead urls: ${deadUrls.size}`);
  console.error(`stations: ${stations.length} → ${kept.length}  (pruned ${removed})`);

  if (a.dryRun) { console.error("dry-run: not writing"); return; }
  await writeFile(resolve(a.stations), compactArrayJSON(kept), "utf8");
  console.error(`wrote ${a.stations}`);
  console.error(`next: node tools/build-index.mjs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Verify the guard fires on a tiny report**

```bash
cd /Users/moon/Projects/claude/kradio
echo '[{"url":"https://x","reachability":"dead"}]' > /tmp/tiny-report.json
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/prune-dead.mjs --report /tmp/tiny-report.json --dry-run; echo "exit=$?"
rm -f /tmp/tiny-report.json
```
Expected: prints "refusing to prune" and `exit=1`.

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/prune-dead.mjs
git commit -m "🧹 feat: conservative hard-dead prune (refuses on truncated report)"
```

---

## Phase 2 — Geo/event classification (LLM + adversarial)

### Task 4: Geo prior + candidate selection (pure)

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/geo-prior.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/geo-prior.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/geo-prior.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { geoPriorForUrl, selectGeoCandidates } from "./geo-prior.mjs";

test("radiko.jp → jp + radiko type", () => {
  assert.deepEqual(geoPriorForUrl("https://f-radiko.smartstream.ne.jp/TBS/_definst_/simul-stream.stream/playlist.m3u8"),
    null); // not the radiko.jp host — must be exact apex match
  assert.deepEqual(geoPriorForUrl("https://radiko.jp/v2/api/ts/playlist.m3u8?station_id=TBS"),
    { country: "jp", type: "radiko" });
});
test("ordinary broadcaster → null (no false geo-lock)", () => {
  assert.equal(geoPriorForUrl("https://liveradio.swr.de/sw282p3/swr3/play.mp3"), null);
  assert.equal(geoPriorForUrl("https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3"), null);
});
test("garbage url → null", () => {
  assert.equal(geoPriorForUrl("not a url"), null);
});

test("selectGeoCandidates: geoHint record is a candidate", () => {
  const recs = [{ name: "X", url: "https://x", reachability: "unknown", geoHint: true }];
  assert.equal(selectGeoCandidates(recs).length, 1);
});
test("selectGeoCandidates: plain reachable global is NOT a candidate", () => {
  const recs = [{ name: "Pop FM", url: "https://pop.example/s.mp3", reachability: "reachable", geoHint: false }];
  assert.equal(selectGeoCandidates(recs).length, 0);
});
test("selectGeoCandidates: radiko prior is a candidate", () => {
  const recs = [{ name: "TBS", url: "https://radiko.jp/x", reachability: "reachable", geoHint: false }];
  assert.equal(selectGeoCandidates(recs).length, 1);
});
test("selectGeoCandidates: event keyword is a candidate", () => {
  const recs = [{ name: "Bundesliga Konferenz", url: "https://x", reachability: "reachable", geoHint: false }];
  assert.equal(selectGeoCandidates(recs).length, 1);
});
test("selectGeoCandidates: dead is never a candidate", () => {
  const recs = [{ name: "X", url: "https://radiko.jp/x", reachability: "dead", geoHint: true }];
  assert.equal(selectGeoCandidates(recs).length, 0);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/geo-prior.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`tools/geo-prior.mjs`:

```js
// tools/geo-prior.mjs
// CONSERVATIVE geo prior. Only DEFINITE audio geo-locks belong here.
//
// IMPORTANT: most public broadcasters (ARD/WDR/SWR/NDR/BR/DLF, BBC radio,
// Radio France, RAI, RTVE …) serve their AUDIO streams GLOBALLY, even though
// their TV/video is geo-fenced. Do NOT add them here — that would create false
// geo-locks. Geo/event detection leans on probe geoHint (403/451) + the LLM
// classify+adversarial pass, defaulting to global. This table is a tiny set of
// streams that genuinely require in-region auth.

const PRIOR = [
  // radiko.jp: hard JP geo + token auth (see RadikoAuthService in the app).
  { test: (h) => h === "radiko.jp" || h.endsWith(".radiko.jp"), country: "jp", type: "radiko" },
];

export function geoPriorForUrl(url) {
  let host;
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  for (const p of PRIOR) {
    if (p.test(host)) return { country: p.country, type: p.type || "direct" };
  }
  return null;
}

const EVENT_RE = /\b(konferenz|bundesliga|liga\b|matchday|gameday|derby|sportschau|live\s?sport|sports?\s?live)\b/i;

// A record needs LLM geo/event judgment when it is not hard-dead AND shows a
// geo/event signal: a probe geoHint (403/451), a geo prior hit, or an
// event-y name. Plain reachable-global entries skip the LLM entirely.
export function selectGeoCandidates(records) {
  return records.filter((r) =>
    r && r.reachability !== "dead" &&
    (r.geoHint === true || geoPriorForUrl(r.url) !== null || EVENT_RE.test(r.name || ""))
  );
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/geo-prior.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/geo-prior.mjs tools/geo-prior.test.mjs
git commit -m "🌍 feat: conservative geo prior + LLM candidate selection (tested)"
```

---

### Task 5: Apply verdicts to featured (pure merge + harness)

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/apply-availability.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/apply-availability.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/apply-availability.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeVerdict } from "./apply-availability.mjs";

test("global verdict → minimal {name,url}", () => {
  const e = { name: "X", url: "https://x", availability: "geo_restricted", countries: ["de"] };
  assert.deepEqual(mergeVerdict(e, { availability: "global" }), { name: "X", url: "https://x" });
});
test("no verdict → minimal {name,url}", () => {
  assert.deepEqual(mergeVerdict({ name: "X", url: "https://x" }, null), { name: "X", url: "https://x" });
});
test("geo_restricted → adds availability + lowercased countries", () => {
  const out = mergeVerdict({ name: "X", url: "https://x" }, { availability: "geo_restricted", countries: ["DE", "AT"] });
  assert.deepEqual(out, { name: "X", url: "https://x", availability: "geo_restricted", countries: ["de", "at"] });
});
test("event_based → adds availability + countries", () => {
  const out = mergeVerdict({ name: "Liga", url: "https://x" }, { availability: "event_based", countries: ["de"] });
  assert.equal(out.availability, "event_based");
});
test("radiko verdict → adds type + stationId, keeps url fallback", () => {
  const out = mergeVerdict({ name: "TBS", url: "https://radiko.jp/x" },
    { availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS" });
  assert.deepEqual(out, {
    name: "TBS", url: "https://radiko.jp/x",
    availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS",
  });
});
test("dead verdict → marks availability dead", () => {
  assert.equal(mergeVerdict({ name: "X", url: "https://x" }, { availability: "dead" }).availability, "dead");
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/apply-availability.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`tools/apply-availability.mjs`:

```js
#!/usr/bin/env node
// tools/apply-availability.mjs
// Pure: mergeVerdict(entry, verdict) → entry with availability metadata applied.
// Harness: read a verdicts JSON (keyed by url) and rewrite featured/{cc}.json
// atomically, in the same compact one-object-per-line style as merge-stations.
//
// Usage:
//   node tools/apply-availability.mjs verdicts.json
//   verdicts.json shape: [{ url, availability, countries?, type?, stationId? }, …]

import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";

export function mergeVerdict(entry, verdict) {
  if (!verdict || verdict.availability === "global") {
    const out = { name: entry.name, url: entry.url };
    return out;
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

function compactArrayJSON(arr) {
  if (arr.length === 0) return "[]\n";
  return "[\n  " + arr.map((o) => JSON.stringify(o)).join(",\n  ") + "\n]\n";
}

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
      if (!v) return entry;                       // no verdict → leave as-is
      const merged = mergeVerdict(entry, v);
      if (JSON.stringify(merged) !== JSON.stringify(entry)) { touched = true; changedEntries++; }
      return merged;
    });
    if (touched) {
      const tmp = `${path}.tmp`;
      await writeFile(tmp, compactArrayJSON(next), "utf8");
      await rename(tmp, path);
      changedFiles++;
    }
  }
  console.error(`applied ${verdicts.length} verdicts → ${changedEntries} entries in ${changedFiles} files`);
}

// Only run main when executed directly (not when imported by the test).
import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/apply-availability.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/apply-availability.mjs tools/apply-availability.test.mjs
git commit -m "🏷️ feat: apply availability verdicts to featured (atomic, tested merge)"
```

---

### Task 6: Author the classification Workflow script

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/availability-classify.workflow.js`

This file is the script passed to the Workflow tool at execution time (Task 8). It is authored here and committed for reproducibility; it is *run* in Phase 3.

- [ ] **Step 1: Write the workflow script**

`tools/availability-classify.workflow.js`:

```js
export const meta = {
  name: 'availability-classify',
  description: 'Classify featured stream availability (geo/event) with adversarial verification',
  phases: [
    { title: 'Classify', detail: 'one agent per candidate: global | geo_restricted | event_based' },
    { title: 'Verify', detail: 'adversarial refute pass on each non-global verdict' },
  ],
}

// args: array of candidate records:
//   { name, url, country, httpStatus, geoHint, signal }
// Returns: { verdicts: [{url, availability, countries?, type?, stationId?, reason}], review: [...] }

const CANDIDATES = Array.isArray(args) ? args : []

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['availability', 'confidence', 'reason'],
  properties: {
    availability: { enum: ['global', 'geo_restricted', 'event_based'] },
    countries: { type: 'array', items: { type: 'string' } },   // lowercase alpha-2, where it IS available
    type: { enum: ['direct', 'radiko'] },
    stationId: { type: 'string' },
    confidence: { enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stillRestricted', 'reason'],
  properties: {
    stillRestricted: { type: 'boolean' },
    reason: { type: 'string' },
  },
}

function classifyPrompt(c) {
  return [
    `You are auditing whether a radio AUDIO stream is globally playable.`,
    `Station: ${JSON.stringify(c.name)}`,
    `URL: ${c.url}`,
    `Listed country: ${c.country}`,
    `Probe evidence: httpStatus=${c.httpStatus ?? 'n/a'}, geoHint=${!!c.geoHint} (403/451 seen), signal=${c.signal}`,
    ``,
    `Rules:`,
    `- DEFAULT to "global". Only choose geo_restricted or event_based with a STRONG signal.`,
    `- A 403/451 (geoHint) is a strong signal the stream is geo- or auth-gated.`,
    `- radiko.jp streams are geo_restricted to Japan and need radiko auth: set`,
    `  availability=geo_restricted, countries=["jp"], type="radiko", and stationId if inferable from the URL.`,
    `- IMPORTANT: public broadcasters (ARD/WDR/SWR/NDR/BR/DLF, BBC radio, Radio France,`,
    `  RAI, RTVE …) almost always serve AUDIO worldwide even when their TV is geo-fenced.`,
    `  Do NOT mark them geo_restricted without a 403/451 probe signal.`,
    `- event_based: only for streams that are live solely during specific events`,
    `  (e.g. a "Bundesliga Konferenz"/match-day sports feed). countries = where it airs.`,
    `- countries lists where the station IS available (lowercase ISO 3166-1 alpha-2).`,
    `Return your classification.`,
  ].join('\n')
}

function refutePrompt(c, verdict) {
  return [
    `A reviewer classified this radio AUDIO stream as "${verdict.availability}"`,
    `${verdict.countries ? `(available in: ${verdict.countries.join(', ')})` : ''}.`,
    `Station: ${JSON.stringify(c.name)} | URL: ${c.url} | probe httpStatus=${c.httpStatus ?? 'n/a'}, geoHint=${!!c.geoHint}.`,
    `Reviewer's reason: ${verdict.reason}`,
    ``,
    `Your job: try to REFUTE the restriction. Is this stream actually globally`,
    `playable audio? Public-broadcaster audio is usually global. If the only`,
    `evidence is a guess (no 403/451, not radiko), the restriction is probably`,
    `wrong — set stillRestricted=false. Keep stillRestricted=true ONLY if the`,
    `restriction is well-supported (probe 403/451, or radiko, or a genuine`,
    `event-only sports feed). When in doubt, refute (false).`,
  ].join('\n')
}

const results = await pipeline(
  CANDIDATES,
  (c) => agent(classifyPrompt(c), { label: `classify:${c.country}:${(c.name || '').slice(0, 24)}`, phase: 'Classify', schema: CLASSIFY_SCHEMA })
    .then((v) => ({ c, v })),
  ({ c, v }) => {
    if (!v || v.availability === 'global') return { c, v, verified: true, restricted: false }
    // adversarial: 3 independent refuters; restriction survives only on majority "still restricted"
    return parallel([0, 1, 2].map((i) => () =>
      agent(refutePrompt(c, v), { label: `verify:${c.country}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    )).then((votes) => {
      const kept = votes.filter(Boolean).filter((x) => x.stillRestricted).length
      const total = votes.filter(Boolean).length || 1
      return { c, v, verified: true, restricted: kept * 2 > total } // strict majority
    })
  }
)

const verdicts = []
const review = []
for (const r of results.filter(Boolean)) {
  if (!r.v) continue
  if (r.v.availability === 'global') continue           // nothing to write; entry stays minimal
  if (r.restricted && r.v.confidence !== 'low') {
    verdicts.push({
      url: r.c.url,
      availability: r.v.availability,
      countries: r.v.countries || [r.c.country],
      ...(r.v.type ? { type: r.v.type } : {}),
      ...(r.v.stationId ? { stationId: r.v.stationId } : {}),
      reason: r.v.reason,
    })
  } else {
    // refuted, or low-confidence restriction → human decides
    review.push({
      url: r.c.url, name: r.c.name, country: r.c.country,
      proposed: r.v.availability, confidence: r.v.confidence,
      restrictedByPanel: r.restricted, reason: r.v.reason,
      httpStatus: r.c.httpStatus, geoHint: r.c.geoHint,
    })
  }
}

log(`candidates=${CANDIDATES.length} verdicts=${verdicts.length} review=${review.length}`)
return { verdicts, review }
```

- [ ] **Step 2: Syntax-check the script**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --check tools/availability-classify.workflow.js`
Expected: no output (the file is valid JS even though `agent`/`pipeline`/`args` are workflow-injected globals).

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/availability-classify.workflow.js
git commit -m "🤖 feat: availability classification workflow (classify + adversarial verify)"
```

---

## Phase 3 — Run it (populate the flags)

> The user explicitly asked for the flags to be verified and populated. These tasks RUN the tools built above. They are not TDD; each ends in a reviewed commit.

### Task 7: Probe the featured set

**Files:**
- Produces: `tools/probe-report.featured.json` (gitignored)

- [ ] **Step 1: Run the featured probe**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs --featured --concurrency 20`
Expected: stderr ends with `wrote tools/probe-report.featured.json — {"reachable":…,"unknown":…,"dead":…}`. ~1,545 entries; takes a few minutes.

- [ ] **Step 2: Eyeball the tallies + dead list**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const r=require("./tools/probe-report.featured.json");
const by=r.reduce((m,x)=>((m[x.reachability]=(m[x.reachability]||0)+1),m),{});
console.log("tally",by);
console.log("geoHint count", r.filter(x=>x.geoHint).length);
console.log("sample dead:", r.filter(x=>x.reachability==="dead").slice(0,10).map(x=>x.country+" "+x.name+" ["+x.signal+"]"));
'
```
Expected: a tally and a readable sample of dead/geoHint entries. Sanity-check that the dead set looks like genuine failures, not a network glitch (if *everything* is dead, your network dropped — re-run).

No commit (the report is gitignored).

---

### Task 8: Classify geo/event + apply to featured

**Files:**
- Produces: `tools/candidates.json` (temp), `tools/availability-verdicts.json` (temp), `tools/availability-review.json` (committed)
- Modifies: `featured/*.json`

- [ ] **Step 1: Extract candidates for the LLM**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/geo-prior.mjs").then(({selectGeoCandidates})=>{
  const r=require("./tools/probe-report.featured.json");
  const c=selectGeoCandidates(r).map(x=>({name:x.name,url:x.url,country:x.country,httpStatus:x.httpStatus,geoHint:x.geoHint,signal:x.signal}));
  require("fs").writeFileSync("tools/candidates.json", JSON.stringify(c,null,0));
  console.log("candidates:", c.length);
});'
```
Expected: prints a candidate count (likely a few dozen — geoHint + radiko + event-keyword only, not all 1,545).

- [ ] **Step 2: Run the classification workflow**

Invoke the Workflow tool with the authored script and the candidates as args:

```
Workflow({
  scriptPath: "/Users/moon/Projects/claude/kradio/tools/availability-classify.workflow.js",
  args: <the parsed contents of tools/candidates.json>   // pass as a real JSON array, not a string
})
```

When it completes, write its return value to disk:
- save `result.verdicts` → `tools/availability-verdicts.json`
- save `result.review` → `tools/availability-review.json`

(If candidates.json is empty, skip the workflow; create `tools/availability-verdicts.json` = `[]` and an empty review.)

- [ ] **Step 3: Human-confirm the review list**

Open `tools/availability-review.json`. For each entry the panel refuted or flagged low-confidence, decide: is it really restricted? Move any you confirm into `tools/availability-verdicts.json` (same shape: `{url, availability, countries, type?, stationId?, reason}`). Leave genuinely-global ones out (absence = global). This is the deliberate human gate from the spec.

- [ ] **Step 4: Apply verdicts to featured**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/apply-availability.mjs tools/availability-verdicts.json`
Expected: `applied N verdicts → M entries in K files`.

- [ ] **Step 5: Review the diff**

Run: `cd /Users/moon/Projects/claude/kradio && git diff --stat featured/ && git diff featured/ | head -80`
Expected: only exception entries gained `availability`/`countries`/`type`/`stationId`; global entries untouched (still `{name,url}`). Confirm no broadcaster was wrongly geo-locked (e.g. SWR/WDR should NOT be geo_restricted unless they returned 403).

- [ ] **Step 6: Clean temp + commit**

```bash
cd /Users/moon/Projects/claude/kradio
rm -f tools/candidates.json tools/availability-verdicts.json
git add featured/*.json tools/availability-review.json
git commit -m "🌍 data: flag geo/event/dead exceptions in featured (verified probe + adversarial)"
```

---

### Task 9: Probe full catalogue + conservative dead-prune

**Files:**
- Produces: `tools/probe-report.full.json` (gitignored)
- Modifies: `stations.json`, `stations.index.json`

- [ ] **Step 1: Probe the full 37k catalogue (background)**

This is long (tens of minutes). Run it in the background:

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs stations.json --concurrency 40 --timeout 8000`
(Use the Bash tool's `run_in_background: true`.) Expected on completion: `wrote tools/probe-report.full.json — {...}`.

- [ ] **Step 2: Dry-run the prune**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/prune-dead.mjs --dry-run`
Expected: prints `stations: 37793 → <kept>  (pruned <N>)`. Sanity: pruned should be a minority (hard-dead only). If it tries to prune a huge fraction, stop and inspect — likely a network issue during probe.

- [ ] **Step 3: Apply the prune**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/prune-dead.mjs`
Expected: `wrote stations.json`.

- [ ] **Step 4: Rebuild the index**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/build-index.mjs`
Expected: `indexed <kept> stations → …/stations.index.json`.

- [ ] **Step 5: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add stations.json stations.index.json
git commit -m "🧹 data: prune hard-dead streams from catalogue (conservative, reindexed)"
git push
```

---

## Phase 4 — iOS geo filter

### Task 10: Decode availability + filter the shelf

**Files:**
- Modify: `/Users/moon/Projects/claude/kbscong/Shared/RemoteStationCatalog.swift`

- [ ] **Step 1: TDD the pure visibility logic via the `swift` CLI**

kbscong has no XCTest target, so test the pure function as a standalone script first. Create `/tmp/isHidden_check.swift`:

```swift
func isHidden(availability: String?, countries: [String]?, userAlpha2: String?) -> Bool {
    switch availability {
    case "dead":
        return true
    case "geo_restricted", "event_based":
        guard let cc = userAlpha2?.lowercased() else { return false } // unknown storefront → don't over-hide
        let allowed = (countries ?? []).map { $0.lowercased() }
        return !allowed.contains(cc)
    default:
        return false // global / nil / unknown string → show
    }
}

// dead → always hidden
assert(isHidden(availability: "dead", countries: nil, userAlpha2: "kr") == true)
// geo: user inside allowed → shown
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: "jp") == false)
// geo: user outside allowed → hidden
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: "de") == true)
// event: user outside → hidden
assert(isHidden(availability: "event_based", countries: ["de"], userAlpha2: "kr") == true)
// geo but unknown storefront → don't over-hide
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: nil) == false)
// global → shown
assert(isHidden(availability: "global", countries: nil, userAlpha2: "de") == false)
// nil availability (backward compat) → shown
assert(isHidden(availability: nil, countries: nil, userAlpha2: "de") == false)
// case-insensitive country match
assert(isHidden(availability: "geo_restricted", countries: ["JP"], userAlpha2: "JP") == false)
print("isHidden: all assertions passed")
```

Run: `swift /tmp/isHidden_check.swift`
Expected: `isHidden: all assertions passed` (and exit 0). If an assertion fails the process traps — fix the function until it passes.

- [ ] **Step 2: Extend `FeaturedEntry` in RemoteStationCatalog.swift**

Replace the existing struct (around line 12):

```swift
    struct FeaturedEntry: Decodable {
        let name: String
        let url: String
    }
```

with:

```swift
    struct FeaturedEntry: Decodable {
        let name: String
        let url: String?            // optional: radiko-only entries may omit it
        let type: String?           // "direct" | "radiko" (absent ⇒ direct)
        let availability: String?   // StreamAvailability raw (absent ⇒ global)
        let countries: [String]?    // lowercase alpha-2 where the station IS available
        let stationId: String?      // present for type == "radiko"
    }
```

- [ ] **Step 3: Add the pure `isHidden` helper**

Add this static method to the `RegionalStations` enum (place it right after `struct FeaturedEntry`):

```swift
    /// Whether a featured entry should be hidden from a user in `userAlpha2`.
    /// `dead` is always hidden; `geo_restricted`/`event_based` are hidden when the
    /// user's storefront isn't in `countries`; everything else (global / nil /
    /// unknown) is shown. Unknown storefront ⇒ don't over-hide.
    static func isHidden(availability: String?, countries: [String]?, userAlpha2: String?) -> Bool {
        switch availability {
        case "dead":
            return true
        case "geo_restricted", "event_based":
            guard let cc = userAlpha2?.lowercased() else { return false }
            let allowed = (countries ?? []).map { $0.lowercased() }
            return !allowed.contains(cc)
        default:
            return false
        }
    }
```

- [ ] **Step 4: Apply the filter + radiko url-fallback in `stations(forAlpha2:)`**

The current body (around lines 58–69) is:

```swift
        return entries.enumerated().compactMap { index, entry in
            guard let streamURL = URL(string: entry.url),
                  let scheme = streamURL.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  !(streamURL.host ?? "").isEmpty else { return nil }
            return RadioStation(
                id: "region_\(alpha2)_\(index)",
                name: entry.name,
                subtitle: streamURL.host ?? entry.url,
                source: .directURL(streamURL),
                iconName: curatedIcon(forKey: entry.url),
                country: displayName
            )
        }
```

Replace it with (note `entry.url` is now optional, and we resolve the user's own storefront for geo comparison):

```swift
        let userAlpha2 = await currentAlpha2()
        return entries.enumerated().compactMap { index, entry in
            // Hide what the user can't play (dead always; geo/event when out of region).
            if isHidden(availability: entry.availability, countries: entry.countries, userAlpha2: userAlpha2) {
                return nil
            }
            // radiko full-auth rendering from featured is a follow-on; for now we
            // only play the direct `url` fallback. An entry with no usable url
            // (e.g. subscription-only radiko) is dropped here.
            guard let urlString = entry.url,
                  let streamURL = URL(string: urlString),
                  let scheme = streamURL.scheme?.lowercased(),
                  scheme == "http" || scheme == "https",
                  !(streamURL.host ?? "").isEmpty else { return nil }
            return RadioStation(
                id: "region_\(alpha2)_\(index)",
                name: entry.name,
                subtitle: streamURL.host ?? urlString,
                source: .directURL(streamURL),
                iconName: curatedIcon(forKey: urlString),
                country: displayName
            )
        }
```

- [ ] **Step 5: Build**

Open the project in Xcode (`KBSRadio.xcodeproj` / `K-Radio Tuner.xcodeproj`) and ⌘B. Expected: clean build. (The decoder change is additive; `currentAlpha2()` is already `async` and `stations(forAlpha2:)` is already `async`, so `await` compiles.)

- [ ] **Step 6: Simulator sanity check**

⌘R. With a German storefront (or any non-JP), open Explore → browse **Japan**. Expected: any JP entry flagged `geo_restricted`/radiko-without-url does not appear; global JP entries still do. Switch the scheme's storefront / region to JP and confirm the JP geo entries reappear. (If you have no geo entries in featured/jp.json yet, temporarily add one by hand to verify, then remove it.)

- [ ] **Step 7: Commit**

```bash
cd /Users/moon/Projects/claude/kbscong
git add Shared/RemoteStationCatalog.swift
git commit -m "🌍 feat: geo-filter featured shelf by availability (+ radiko url fallback)"
git push
```

---

## Phase 5 — Documentation

### Task 11: Document the schema in featured/README.md

**Files:**
- Modify: `/Users/moon/Projects/claude/kradio/featured/README.md`

- [ ] **Step 1: Append the schema section**

Add to the end of `featured/README.md`:

```markdown
## Availability metadata (optional)

Entries default to globally playable; only **exceptions** carry extra fields.
A normal entry stays `{ "name", "url" }`.

```ts
type StreamAvailability =
  | "global"          // default when the field is absent
  | "geo_restricted"
  | "event_based"
  | "unknown"
  | "dead";

interface FeaturedEntry {
  name: string;
  url?: string;                       // direct stream; also the FALLBACK for radiko entries
  type?: "direct" | "radiko";         // absent ⇒ "direct"
  stationId?: string;                 // when type === "radiko" (subscribed auth path)
  availability?: StreamAvailability;  // absent ⇒ "global"
  countries?: string[];               // lowercase alpha-2; where a geo/event station IS available
}
```

- Absent `availability` ⇒ `global`. Annotate exceptions only.
- `countries` lists where a `geo_restricted`/`event_based` station is available.
- **radiko** carries both `stationId` (subscribed auth path via `RadikoAuthService`)
  and a fallback `url`. Without a subscription the app plays the `url` best-effort.
- The app hides `dead` always, and `geo_restricted`/`event_based` when the user's
  storefront isn't in `countries`.

Flags are produced by `tools/probe-streams.mjs` (reachability) + the
`tools/availability-classify.workflow.js` LLM pass (geo/event) and applied with
`tools/apply-availability.mjs`. Hard-dead catalogue entries are pruned by
`tools/prune-dead.mjs`. See `docs/superpowers/specs/2026-06-06-stream-availability-design.md`.
```

- [ ] **Step 2: Commit + push**

```bash
cd /Users/moon/Projects/claude/kradio
git add featured/README.md
git commit -m "📚 docs: document availability metadata + radiko dual-path in featured/README"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Schema (StreamAvailability + optional fields, url-as-radiko-fallback) | Tasks 5, 10, 11 |
| Probe evidence sidecar (`probe-report.*.json`, gitignored) | Tasks 2, 7, 9 |
| `probe-streams.mjs` reachability (dead/reachable/unknown, 403/451 geoHint, 5xx retry) | Tasks 1, 2 |
| Classification workflow (domain prior, conservative global, adversarial verify, human-confirm) | Tasks 4, 6, 8 |
| `prune-dead.mjs` conservative (hard signals only; 5xx/403/timeout kept) | Tasks 1 (`isPrunable`), 3, 9 |
| iOS decode + geo filter (dead always; geo/event when out of region; radiko fallback; backward compat) | Task 10 |
| Conservative pruning protects Korea-only-from-Europe streams | Task 1 (`isPrunable` keeps unknown), Task 3 (hard-dead only) |
| featured/README documentation | Task 11 |
| Repo/file layout | matches the File Structure section |
| radiko graceful degrade (subscribed → stationId; else → url) | Tasks 5 (mergeVerdict keeps url+stationId), 10 (url fallback, radiko follow-on), 11 |
| Out-of-scope (full radiko render, category, multi-region, full-catalogue availability) | not implemented; noted in Task 10 follow-on comment |

**Type / name consistency:**
- `classifyReachability` / `isPrunable` exported from `probe-classify.mjs`; imported in `probe-streams.mjs` (Task 2) and `prune-dead.mjs` (Task 3) ✓
- record shape `{name,url,country,httpStatus,contentType,reachability,geoHint,signal,checkedAt,error?}` produced in Task 2, consumed in Tasks 3 (`isPrunable` reads `reachability`), 4 (`selectGeoCandidates` reads `reachability,geoHint,url,name`), 8 ✓
- `geoPriorForUrl` / `selectGeoCandidates` exported from `geo-prior.mjs`; used in Task 8 Step 1 ✓
- `mergeVerdict` exported from `apply-availability.mjs`; verdict shape `{url,availability,countries?,type?,stationId?}` matches the workflow output (Task 6) and the apply harness (Task 5) ✓
- iOS `isHidden(availability:countries:userAlpha2:)` signature identical in the `/tmp` TDD scratch (Task 10 Step 1) and the real method (Step 3) ✓
- `FeaturedEntry.url` becomes optional in Task 10 Step 2; every later use (`entry.url` guard) handles the optional ✓
- Reachability vocabulary `dead|reachable|unknown` identical across classifier, prune, candidate selection, workflow, README ✓

**Placeholder scan:** No TBD/TODO/"similar to above". Task 8 Step 2 references "the parsed contents of tools/candidates.json" — that is a concrete instruction to pass the file's JSON array as the Workflow `args`, not a placeholder. Every code step has complete code.

Plan is clean.

---

## Execution Handoff

Plan saved to `/Users/moon/Projects/claude/kradio/docs/superpowers/plans/2026-06-06-stream-availability.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks. Phase 3 (the probe + workflow run) stays with the main session since it invokes the Workflow tool and needs your human-confirm on the review list.
2. **Inline Execution** — execute here with checkpoints (this lets me run the probe + classification Workflow directly, which fits the "verify and populate" ask best).

Which approach?
