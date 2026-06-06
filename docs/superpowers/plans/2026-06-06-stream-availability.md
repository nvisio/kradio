# Stream Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a weekly automated stream-health pipeline (GitHub Actions → `health.json` served via CDN), populate geo/event availability on the curated featured set once, and have the iOS app fetch both layers + keep a bundled fallback.

**Architecture:** Two layers on two cadences. **Health** (reachability) is regenerated weekly by a GitHub Action that runs a deterministic, dependency-free probe over the 37k catalogue and commits a compact `health.json` deny-list (LLM-free). **Availability** (geo/event) is an occasional, by-hand LLM Workflow over the few hundred featured candidates with adversarial verification. The iOS app fetches `health.json` + `featured/{cc}.json`, hides dead/geo-restricted, fails open on fetch error, and keeps the existing KR/UK/JP built-ins as the offline fallback.

**Tech Stack:** Node ≥20 built-ins (`node:test`, `fetch`, `AbortController`) — no new deps; GitHub Actions (weekly cron); the Workflow tool for the LLM geo pass; Swift/SwiftUI (pure logic TDD'd via the `swift` CLI — kbscong has no XCTest target).

**Repos:**
- Public: `/Users/moon/Projects/claude/kradio` → `nvisio/kradio`
- iOS (private): `/Users/moon/Projects/claude/kbscong`

**Spec:** `docs/superpowers/specs/2026-06-06-stream-availability-design.md`

**Node:** prefix every `node` command with `PATH="/usr/local/opt/node@22/bin:$PATH"` (v22). Default `node` is v21 and also works.

**Datacenter-IP caveat (drives the conservative classifier):** the weekly Action runs from GitHub's US datacenter IPs, which radio CDNs 403/block more than residential IPs. So `dead` is hard-signal-only; 403/451 → `unknown`+`geoHint` (never dead); the app hides only `dead`.

---

## File Structure

### `nvisio/kradio`
```
tools/
├── probe-classify.mjs            # NEW — pure classifyReachability(), isPrunable()
├── probe-classify.test.mjs       # NEW — node:test
├── probe-streams.mjs             # NEW — concurrent probe harness → probe-report.*.json
├── build-health.mjs              # NEW — pure toHealth() + harness → health.json
├── build-health.test.mjs         # NEW — node:test
├── prune-dead.mjs                # NEW — OCCASIONAL hard compaction (not in weekly Action)
├── geo-prior.mjs                 # NEW — pure geoPriorForUrl(), selectGeoCandidates()
├── geo-prior.test.mjs            # NEW — node:test
├── apply-availability.mjs        # NEW — pure mergeVerdict() + harness → featured/
├── apply-availability.test.mjs   # NEW — node:test
├── availability-classify.workflow.js  # NEW — Workflow (LLM classify + adversarial)
├── availability-review.json      # human-confirm list (committed)
└── probe-report.*.json           # ARTIFACTS (gitignored)
.github/workflows/health-check.yml # NEW — weekly cron
health.json                        # NEW — committed status layer, served via CDN
featured/*.json                    # exception entries annotated
featured/README.md                 # MODIFY — schema docs
.gitignore                         # MODIFY — tools/probe-report*.json
```

### `kbscong`
```
Shared/RemoteStationCatalog.swift  # MODIFY — health fetch + fallback + geo decode/filter
```

---

## Phase 1 — Health pipeline tools (deterministic, TDD)

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
test("206 HLS playlist → reachable", () => {
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
  assert.equal(isPrunable({ reachability: "unknown" }), false);
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
// Pure reachability classifier. No network, no side effects.
//
//   "dead"      — hard failure (DNS NXDOMAIN, conn refused, TLS invalid, 404, 410).
//                 Exactly the set safe to prune / hard-hide.
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
Expected: all PASS.

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

- [ ] **Step 1: Broaden .gitignore**

In `.gitignore`, change the exact line `tools/probe-report.json` to:

`tools/probe-report*.json`

(If the line isn't present, add it.) Do NOT ignore `health.json` — it is committed.

- [ ] **Step 2: Write the harness**

`tools/probe-streams.mjs`:

```js
#!/usr/bin/env node
// tools/probe-streams.mjs
// Deterministic, LLM-free stream reachability probe. Writes a sidecar report;
// never touches featured/ or stations.json.
//
//   node tools/probe-streams.mjs --featured                    → tools/probe-report.featured.json
//   node tools/probe-streams.mjs stations.json                 → tools/probe-report.full.json
//   node tools/probe-streams.mjs <input> --out f --concurrency 40 --timeout 8000

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
    if (r.status >= 500) {
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
      out[idx] = await fn(items[idx]);
      if (++done % 200 === 0) process.stderr.write(`  probed ${done}/${items.length}\n`);
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
  await writeFile(resolve(out), JSON.stringify(records) + "\n", "utf8");
  const tally = records.reduce((m, r) => ((m[r.reachability] = (m[r.reachability] || 0) + 1), m), {});
  console.error(`wrote ${out} — ${JSON.stringify(tally)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 3: Smoke-test on a 5-entry slice**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const fs=require("fs");
(async()=>{ for(const e of JSON.parse(fs.readFileSync("featured/de.json")).slice(0,5)){
  try{const r=await fetch(e.url,{method:"GET",headers:{Range:"bytes=0-1"}});console.log(r.status,(r.headers.get("content-type")||"").slice(0,28),e.name);}
  catch(err){console.log("ERR",err.cause?.code||err.code,e.name);} } })();'
```
Expected: 5 lines, mostly `200`/`206` with `audio/...` types (proves `fetch`+`Range` resolves real streams here).

- [ ] **Step 4: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/probe-streams.mjs .gitignore
git commit -m "🛰️ feat: deterministic concurrent stream probe harness"
```

---

### Task 3: Distil report → health.json

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/build-health.mjs`
- Create: `/Users/moon/Projects/claude/kradio/tools/build-health.test.mjs`

- [ ] **Step 1: Write the failing test**

`tools/build-health.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { toHealth } from "./build-health.mjs";

const recs = [
  { url: "https://ok1", reachability: "reachable", signal: "ok", httpStatus: 200 },
  { url: "https://ok2", reachability: "reachable", signal: "ok", httpStatus: 206 },
  { url: "https://dead1", reachability: "dead", signal: "ENOTFOUND", httpStatus: null },
  { url: "https://geo1", reachability: "unknown", signal: "http_403", httpStatus: 403, geoHint: true },
];

test("counts healthy/unknown/dead", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.deepEqual(h.counts, { healthy: 2, unknown: 1, dead: 1 });
  assert.equal(h.total, 4);
  assert.equal(h.vantage, "test");
});
test("unhealthy lists only non-healthy, with fields", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.equal(h.unhealthy.length, 2);
  const dead = h.unhealthy.find((u) => u.url === "https://dead1");
  assert.deepEqual(dead, { url: "https://dead1", status: "dead", signal: "ENOTFOUND", httpStatus: null });
});
test("geoHint preserved only when true", () => {
  const h = toHealth(recs, { vantage: "test" });
  const geo = h.unhealthy.find((u) => u.url === "https://geo1");
  assert.equal(geo.geoHint, true);
  const dead = h.unhealthy.find((u) => u.url === "https://dead1");
  assert.equal("geoHint" in dead, false);
});
test("healthy URLs are omitted from unhealthy", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.equal(h.unhealthy.some((u) => u.url.startsWith("https://ok")), false);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/build-health.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`tools/build-health.mjs`:

```js
#!/usr/bin/env node
// tools/build-health.mjs
// Distil a probe report into health.json — a compact deny-list of non-healthy
// URLs (absent ⇒ healthy). Pure toHealth() is unit-tested; the harness adds the
// timestamp and refuses to write on a suspiciously small report.
//
//   node tools/build-health.mjs [--report tools/probe-report.full.json] [--out health.json]
//   HEALTH_VANTAGE=github-actions-us node tools/build-health.mjs

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function toHealth(records, { vantage = "local" } = {}) {
  const counts = { healthy: 0, unknown: 0, dead: 0 };
  const unhealthy = [];
  for (const r of records) {
    const status = r.reachability === "reachable" ? "healthy" : r.reachability;
    counts[status] = (counts[status] || 0) + 1;
    if (status !== "healthy") {
      const row = { url: r.url, status, signal: r.signal, httpStatus: r.httpStatus ?? null };
      if (r.geoHint) row.geoHint = true;
      unhealthy.push(row);
    }
  }
  return { vantage, total: records.length, counts, unhealthy };
}

const MIN_REPORT = 1000;

async function main() {
  const argv = process.argv.slice(2);
  let report = "tools/probe-report.full.json", out = "health.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") report = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
  }
  const records = JSON.parse(await readFile(resolve(report), "utf8"));
  if (!Array.isArray(records) || records.length < MIN_REPORT) {
    throw new Error(`report ${report} has ${records.length} rows (< ${MIN_REPORT}); refusing to overwrite ${out}`);
  }
  const health = {
    generatedAt: new Date().toISOString(),
    ...toHealth(records, { vantage: process.env.HEALTH_VANTAGE || "local" }),
  };
  await writeFile(resolve(out), JSON.stringify(health) + "\n", "utf8");
  console.error(`wrote ${out} — ${JSON.stringify(health.counts)} (unhealthy rows: ${health.unhealthy.length})`);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run, expect pass**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --test tools/build-health.test.mjs`
Expected: all PASS.

- [ ] **Step 5: Verify the report-size guard**

```bash
cd /Users/moon/Projects/claude/kradio
echo '[{"url":"https://x","reachability":"dead","signal":"ENOTFOUND"}]' > /tmp/tiny.json
PATH="/usr/local/opt/node@22/bin:$PATH" node tools/build-health.mjs --report /tmp/tiny.json --out /tmp/health.json; echo "exit=$?"
rm -f /tmp/tiny.json /tmp/health.json
```
Expected: "refusing to overwrite" and `exit=1`.

- [ ] **Step 6: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/build-health.mjs tools/build-health.test.mjs
git commit -m "🩺 feat: distil probe report → compact health.json (tested)"
```

---

### Task 4: Occasional hard-compaction tool

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/prune-dead.mjs`

Not part of the weekly Action — `health.json` + runtime filtering is the live mechanism. This tool is for an occasional manual compaction of long-dead entries. Reuses the tested `isPrunable`.

- [ ] **Step 1: Write the harness**

`tools/prune-dead.mjs`:

```js
#!/usr/bin/env node
// tools/prune-dead.mjs
// OCCASIONAL manual compaction: physically remove hard-dead entries from
// stations.json, keyed by URL, using a probe report. Only reachability ===
// "dead" (DNS/conn/TLS/404/410) is removed; timeouts, 403, 5xx are kept.
// Refuses on a suspiciously small report. NOT run on a schedule.
//
//   node tools/prune-dead.mjs [--report tools/probe-report.full.json] [--stations stations.json] [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrunable } from "./probe-classify.mjs";

const MIN_REPORT = 1000;

function parseArgs(argv) {
  const o = { report: "tools/probe-report.full.json", stations: "stations.json", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") o.report = argv[++i];
    else if (argv[i] === "--stations") o.stations = argv[++i];
    else if (argv[i] === "--dry-run") o.dryRun = true;
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
  console.error(`report ${report.length}  hard-dead ${deadUrls.size}  stations ${stations.length} → ${kept.length} (pruned ${stations.length - kept.length})`);
  if (a.dryRun) { console.error("dry-run: not writing"); return; }
  await writeFile(resolve(a.stations), compactArrayJSON(kept), "utf8");
  console.error(`wrote ${a.stations}\nnext: node tools/build-index.mjs`);
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
Expected: "refusing to prune" and `exit=1`.

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/prune-dead.mjs
git commit -m "🧹 feat: occasional hard-dead compaction tool (refuses on truncated report)"
```

---

## Phase 2 — Weekly automation

### Task 5: GitHub Actions weekly health check

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/.github/workflows/health-check.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/health-check.yml`:

```yaml
name: Weekly stream health check

on:
  schedule:
    - cron: "17 3 * * 1"      # Mondays 03:17 UTC
  workflow_dispatch: {}        # allow manual runs

permissions:
  contents: write

concurrency:
  group: health-check
  cancel-in-progress: false

jobs:
  health:
    runs-on: ubuntu-latest
    timeout-minutes: 120
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
      - name: Probe full catalogue
        run: node tools/probe-streams.mjs stations.json --concurrency 40 --timeout 8000
      - name: Build health.json
        env:
          HEALTH_VANTAGE: github-actions-us
        run: node tools/build-health.mjs
      - name: Commit health.json if changed
        run: |
          git config user.name  "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add health.json
          if git diff --staged --quiet; then
            echo "no health change"
          else
            git commit -m "🩺 chore: weekly stream health refresh"
            git push
          fi
```

Notes for the implementer:
- `probe-report.full.json` is gitignored (Task 2), so the Action never commits it — only `health.json`.
- The probe over ~37k entries takes tens of minutes; `timeout-minutes: 120` is headroom.
- If the repo has branch protection on `main` that blocks the Actions bot, switch the commit step to open a PR instead (out of scope here; note it in the PR description).

- [ ] **Step 2: Lint the YAML**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const fs=require("fs");const s=fs.readFileSync(".github/workflows/health-check.yml","utf8");
// minimal structural sanity (no YAML dep): required keys present
for(const k of ["on:","schedule:","workflow_dispatch:","permissions:","contents: write","probe-streams.mjs","build-health.mjs"]){
  if(!s.includes(k)) throw new Error("missing: "+k);
}
console.log("workflow structure OK");'
```
Expected: `workflow structure OK`.

- [ ] **Step 3: Commit + push (so the Action becomes available)**

```bash
cd /Users/moon/Projects/claude/kradio
git add .github/workflows/health-check.yml
git commit -m "⚙️ ci: weekly stream health-check workflow (probe → health.json)"
git push
```

- [ ] **Step 4: Validate via a manual dispatch (after first health.json exists — see Task 9)**

After Task 9 has committed an initial `health.json`, trigger the Action once to confirm CI works end to end:

```bash
gh workflow run "Weekly stream health check" -R nvisio/kradio
gh run watch -R nvisio/kradio
```
Expected: the run succeeds; if any stream health changed since Task 9, a `🩺 chore: weekly stream health refresh` commit appears. (From the datacenter vantage expect a somewhat larger `unknown`/`dead` count than a local run — that's the documented IP caveat; `vantage` in `health.json` will read `github-actions-us`.)

---

## Phase 3 — Availability (geo/event) tools (TDD)

### Task 6: Geo prior + candidate selection (pure)

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
test("geoHint record is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "X", url: "https://x", reachability: "unknown", geoHint: true }]).length, 1);
});
test("plain reachable global is NOT a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "Pop FM", url: "https://pop.example/s.mp3", reachability: "reachable", geoHint: false }]).length, 0);
});
test("radiko prior is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "TBS", url: "https://radiko.jp/x", reachability: "reachable", geoHint: false }]).length, 1);
});
test("event keyword is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "Bundesliga Konferenz", url: "https://x", reachability: "reachable", geoHint: false }]).length, 1);
});
test("dead is never a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "X", url: "https://radiko.jp/x", reachability: "dead", geoHint: true }]).length, 0);
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
// Radio France, RAI, RTVE …) serve their AUDIO worldwide even though their
// TV/video is geo-fenced. Do NOT add them — that would create false geo-locks.
// Geo/event detection leans on probe geoHint (403/451) + the LLM
// classify+adversarial pass, defaulting to global.

const PRIOR = [
  // radiko.jp: hard JP geo + token auth (see RadikoAuthService in the app).
  { test: (h) => h === "radiko.jp" || h.endsWith(".radiko.jp"), country: "jp", type: "radiko" },
];

export function geoPriorForUrl(url) {
  let host;
  try { host = new URL(url).host.toLowerCase(); } catch { return null; }
  for (const p of PRIOR) if (p.test(host)) return { country: p.country, type: p.type || "direct" };
  return null;
}

const EVENT_RE = /\b(konferenz|bundesliga|liga\b|matchday|gameday|derby|sportschau|live\s?sport|sports?\s?live)\b/i;

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

### Task 7: Apply verdicts to featured (pure merge + harness)

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
test("event_based → adds availability", () => {
  assert.equal(mergeVerdict({ name: "Liga", url: "https://x" }, { availability: "event_based", countries: ["de"] }).availability, "event_based");
});
test("radiko verdict → adds type + stationId, keeps url fallback", () => {
  const out = mergeVerdict({ name: "TBS", url: "https://radiko.jp/x" },
    { availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS" });
  assert.deepEqual(out, { name: "TBS", url: "https://radiko.jp/x", availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS" });
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
      if (!v) return entry;
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

### Task 8: Author the classification Workflow script

**Files:**
- Create: `/Users/moon/Projects/claude/kradio/tools/availability-classify.workflow.js`

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

// args: [{ name, url, country, httpStatus, geoHint, signal }]
// returns: { verdicts: [{url, availability, countries?, type?, stationId?, reason}], review: [...] }

const CANDIDATES = Array.isArray(args) ? args : []

const CLASSIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['availability', 'confidence', 'reason'],
  properties: {
    availability: { enum: ['global', 'geo_restricted', 'event_based'] },
    countries: { type: 'array', items: { type: 'string' } },
    type: { enum: ['direct', 'radiko'] },
    stationId: { type: 'string' },
    confidence: { enum: ['low', 'medium', 'high'] },
    reason: { type: 'string' },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['stillRestricted', 'reason'],
  properties: { stillRestricted: { type: 'boolean' }, reason: { type: 'string' } },
}

function classifyPrompt(c) {
  return [
    `Audit whether a radio AUDIO stream is globally playable.`,
    `Station: ${JSON.stringify(c.name)}  URL: ${c.url}  Listed country: ${c.country}`,
    `Probe: httpStatus=${c.httpStatus ?? 'n/a'}, geoHint=${!!c.geoHint} (403/451), signal=${c.signal}`,
    ``,
    `Rules:`,
    `- DEFAULT to "global". Only geo_restricted/event_based with a STRONG signal.`,
    `- A 403/451 (geoHint) is a strong geo/auth signal.`,
    `- radiko.jp → geo_restricted, countries=["jp"], type="radiko", stationId if inferable.`,
    `- Public broadcasters (ARD/WDR/SWR/NDR/DLF, BBC radio, Radio France, RAI, RTVE)`,
    `  serve AUDIO worldwide; do NOT mark geo_restricted without a 403/451.`,
    `- event_based: live only during specific events (e.g. a Bundesliga Konferenz feed).`,
    `- countries = where it IS available (lowercase alpha-2).`,
  ].join('\n')
}
function refutePrompt(c, v) {
  return [
    `A reviewer marked this radio AUDIO stream "${v.availability}"${v.countries ? ` (in: ${v.countries.join(', ')})` : ''}.`,
    `Station: ${JSON.stringify(c.name)} URL: ${c.url} probe httpStatus=${c.httpStatus ?? 'n/a'} geoHint=${!!c.geoHint}.`,
    `Reason: ${v.reason}`,
    `Try to REFUTE the restriction. Public-broadcaster audio is usually global.`,
    `If the only evidence is a guess (no 403/451, not radiko), set stillRestricted=false.`,
    `Keep true ONLY if well-supported (403/451, radiko, or a genuine event-only feed).`,
    `When in doubt, refute (false).`,
  ].join('\n')
}

const results = await pipeline(
  CANDIDATES,
  (c) => agent(classifyPrompt(c), { label: `classify:${c.country}:${(c.name || '').slice(0, 20)}`, phase: 'Classify', schema: CLASSIFY_SCHEMA }).then((v) => ({ c, v })),
  ({ c, v }) => {
    if (!v || v.availability === 'global') return { c, v, restricted: false }
    return parallel([0, 1, 2].map((i) => () =>
      agent(refutePrompt(c, v), { label: `verify:${c.country}:${i}`, phase: 'Verify', schema: VERDICT_SCHEMA })
    )).then((votes) => {
      const kept = votes.filter(Boolean).filter((x) => x.stillRestricted).length
      const total = votes.filter(Boolean).length || 1
      return { c, v, restricted: kept * 2 > total }
    })
  }
)

const verdicts = [], review = []
for (const r of results.filter(Boolean)) {
  if (!r.v || r.v.availability === 'global') continue
  if (r.restricted && r.v.confidence !== 'low') {
    verdicts.push({ url: r.c.url, availability: r.v.availability, countries: r.v.countries || [r.c.country],
      ...(r.v.type ? { type: r.v.type } : {}), ...(r.v.stationId ? { stationId: r.v.stationId } : {}), reason: r.v.reason })
  } else {
    review.push({ url: r.c.url, name: r.c.name, country: r.c.country, proposed: r.v.availability,
      confidence: r.v.confidence, restrictedByPanel: r.restricted, reason: r.v.reason, httpStatus: r.c.httpStatus, geoHint: r.c.geoHint })
  }
}
log(`candidates=${CANDIDATES.length} verdicts=${verdicts.length} review=${review.length}`)
return { verdicts, review }
```

- [ ] **Step 2: Syntax-check**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node --check tools/availability-classify.workflow.js`
Expected: no output (valid JS; `agent`/`pipeline`/`args`/`log` are workflow-injected globals).

- [ ] **Step 3: Commit**

```bash
cd /Users/moon/Projects/claude/kradio
git add tools/availability-classify.workflow.js
git commit -m "🤖 feat: availability classification workflow (classify + adversarial)"
```

---

## Phase 4 — Run it (seed health.json + populate availability)

### Task 9: First health run (seed health.json) + reindex check

**Files:**
- Produces: `tools/probe-report.full.json` (gitignored), `health.json` (committed)

- [ ] **Step 1: Probe the full catalogue (background)**

Run (use the Bash tool's `run_in_background: true` — this takes tens of minutes):
`cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs stations.json --concurrency 40 --timeout 8000`
Expected on completion: `wrote tools/probe-report.full.json — {"reachable":…,"unknown":…,"dead":…}`.

- [ ] **Step 2: Build health.json locally (vantage = local)**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/build-health.mjs`
Expected: `wrote health.json — {"healthy":…,"unknown":…,"dead":…} (unhealthy rows: N)`.

- [ ] **Step 3: Sanity-check health.json**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
const h=require("./health.json");
console.log("vantage", h.vantage, "total", h.total, "counts", h.counts);
console.log("dead sample:", h.unhealthy.filter(u=>u.status==="dead").slice(0,8).map(u=>u.signal+" "+u.url));
console.log("dead %", (h.counts.dead/h.total*100).toFixed(1));'
```
Expected: `dead %` is a small minority (hard-dead only). If it's a large fraction, the probe hit a network problem — re-run Step 1 before committing.

- [ ] **Step 4: Commit the seed health.json**

```bash
cd /Users/moon/Projects/claude/kradio
git add health.json
git commit -m "🩺 data: seed initial stream health.json"
git push
```
(Now Task 5 Step 4's manual `gh workflow run` validation can be performed — the Action will refresh this file weekly from the CI vantage.)

---

### Task 10: Populate geo/event availability on featured

**Files:**
- Produces: `tools/probe-report.featured.json` (gitignored), `tools/availability-review.json` (committed)
- Modifies: `featured/*.json`

- [ ] **Step 1: Probe the featured set**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/probe-streams.mjs --featured --concurrency 20`
Expected: `wrote tools/probe-report.featured.json — {...}` (~1,545 entries, a few minutes).

- [ ] **Step 2: Extract candidates**

```bash
cd /Users/moon/Projects/claude/kradio
PATH="/usr/local/opt/node@22/bin:$PATH" node -e '
import("./tools/geo-prior.mjs").then(({selectGeoCandidates})=>{
  const r=require("./tools/probe-report.featured.json");
  const c=selectGeoCandidates(r).map(x=>({name:x.name,url:x.url,country:x.country,httpStatus:x.httpStatus,geoHint:x.geoHint,signal:x.signal}));
  require("fs").writeFileSync("tools/candidates.json", JSON.stringify(c));
  console.log("candidates:", c.length);
});'
```
Expected: a small count (geoHint + radiko + event-keyword only — likely a few dozen, not 1,545).

- [ ] **Step 3: Run the classification workflow**

Invoke the Workflow tool:

```
Workflow({
  scriptPath: "/Users/moon/Projects/claude/kradio/tools/availability-classify.workflow.js",
  args: <parsed JSON array from tools/candidates.json>   // pass the real array, not a string
})
```

Save the return value: `result.verdicts` → `tools/availability-verdicts.json`; `result.review` → `tools/availability-review.json`. If `candidates.json` is `[]`, skip the workflow and set `tools/availability-verdicts.json` = `[]`.

- [ ] **Step 4: Human-confirm the review list**

Open `tools/availability-review.json`. For each refuted / low-confidence row, decide if it is genuinely restricted. Move confirmed ones into `tools/availability-verdicts.json` (shape `{url, availability, countries, type?, stationId?, reason}`). Leave global ones out (absence ⇒ global).

- [ ] **Step 5: Apply verdicts**

Run: `cd /Users/moon/Projects/claude/kradio && PATH="/usr/local/opt/node@22/bin:$PATH" node tools/apply-availability.mjs tools/availability-verdicts.json`
Expected: `applied N verdicts → M entries in K files`.

- [ ] **Step 6: Review the diff**

Run: `cd /Users/moon/Projects/claude/kradio && git diff --stat featured/ && git diff featured/ | head -80`
Expected: only exception entries gained fields; globals untouched (`{name,url}`). Confirm no public broadcaster was wrongly geo-locked (SWR/WDR/BBC radio should stay global unless they returned 403).

- [ ] **Step 7: Clean temp + commit**

```bash
cd /Users/moon/Projects/claude/kradio
rm -f tools/candidates.json tools/availability-verdicts.json
git add featured/*.json tools/availability-review.json
git commit -m "🌍 data: flag geo/event exceptions in featured (probe + adversarial verify)"
git push
```

---

## Phase 5 — iOS (health fetch + fallback + geo filter)

### Task 11: Fetch health + decode availability + filter

**Files:**
- Modify: `/Users/moon/Projects/claude/kbscong/Shared/RemoteStationCatalog.swift`

- [ ] **Step 1: TDD the pure logic via the `swift` CLI**

kbscong has no XCTest target, so test the pure helpers as a standalone script. Create `/tmp/health_check.swift`:

```swift
import Foundation

func normalizeURL(_ u: String) -> String { u.trimmingCharacters(in: .whitespaces).lowercased() }

func isHidden(availability: String?, countries: [String]?, userAlpha2: String?) -> Bool {
    switch availability {
    case "dead":
        return true
    case "geo_restricted", "event_based":
        guard let cc = userAlpha2?.lowercased() else { return false }
        return !((countries ?? []).map { $0.lowercased() }.contains(cc))
    default:
        return false
    }
}

func isDead(_ url: String, deadSet: Set<String>) -> Bool { deadSet.contains(normalizeURL(url)) }

// isHidden
assert(isHidden(availability: "dead", countries: nil, userAlpha2: "kr") == true)
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: "jp") == false)
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: "de") == true)
assert(isHidden(availability: "event_based", countries: ["de"], userAlpha2: "kr") == true)
assert(isHidden(availability: "geo_restricted", countries: ["jp"], userAlpha2: nil) == false)
assert(isHidden(availability: "global", countries: nil, userAlpha2: "de") == false)
assert(isHidden(availability: nil, countries: nil, userAlpha2: "de") == false)
assert(isHidden(availability: "geo_restricted", countries: ["JP"], userAlpha2: "JP") == false)
// health dead set (case/whitespace-insensitive)
let dead: Set<String> = ["https://dead.example/s.mp3"]
assert(isDead("  https://Dead.example/s.mp3 ", deadSet: dead) == true)
assert(isDead("https://ok.example/s.mp3", deadSet: dead) == false)
print("health+isHidden: all assertions passed")
```

Run: `swift /tmp/health_check.swift`
Expected: `health+isHidden: all assertions passed`, exit 0. (Fix the functions until it passes; a failed assert traps.)

- [ ] **Step 2: Add the health fetch + `HealthList`**

In `Shared/RemoteStationCatalog.swift`, add this above `enum RegionalStations` (top-level):

```swift
/// Dead-URL deny-list fetched weekly-regenerated from the CDN. Absent URLs are
/// healthy. Only `dead` is hard-hidden; `unknown` stays visible (the health probe
/// runs from datacenter IPs and over-reports 403/timeouts).
struct HealthList: Sendable {
    let deadURLs: Set<String>
    static let empty = HealthList(deadURLs: [])
    func isDead(_ url: String) -> Bool { deadURLs.contains(HealthList.normalize(url)) }
    static func normalize(_ u: String) -> String { u.trimmingCharacters(in: .whitespaces).lowercased() }
}

enum StreamHealth {
    private struct HealthFile: Decodable {
        struct Row: Decodable { let url: String; let status: String }
        let unhealthy: [Row]
    }
    /// Fail-open: any fetch/decode failure yields an empty list (show everything).
    static func fetch() async -> HealthList {
        guard let url = URL(string: "https://kradio.nvis.io/health.json") else { return .empty }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadRevalidatingCacheData
        req.timeoutInterval = 10
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let file = try? JSONDecoder().decode(HealthFile.self, from: data)
        else { return .empty }
        let dead = file.unhealthy.filter { $0.status == "dead" }.map { HealthList.normalize($0.url) }
        return HealthList(deadURLs: Set(dead))
    }
}
```

- [ ] **Step 3: Extend `FeaturedEntry` + add `isHidden`**

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
        let type: String?           // "direct" | "radiko"
        let availability: String?   // StreamAvailability raw (absent ⇒ global)
        let countries: [String]?    // lowercase alpha-2 where it IS available
        let stationId: String?
    }

    /// Hide what the user can't play: dead always; geo/event when out of region.
    static func isHidden(availability: String?, countries: [String]?, userAlpha2: String?) -> Bool {
        switch availability {
        case "dead":
            return true
        case "geo_restricted", "event_based":
            guard let cc = userAlpha2?.lowercased() else { return false }
            return !((countries ?? []).map { $0.lowercased() }.contains(cc))
        default:
            return false
        }
    }
```

- [ ] **Step 4: Filter in `stations(forAlpha2:)`**

Change the signature to accept a health list, and replace the body's `compactMap`. The method currently starts at line 44 (`static func stations(forAlpha2 alpha2: String) async -> [RadioStation]?`). Update the signature:

```swift
    static func stations(forAlpha2 alpha2: String, health: HealthList = .empty) async -> [RadioStation]? {
```

and replace the `return entries.enumerated().compactMap { … }` block (lines ~58–69) with:

```swift
        let userAlpha2 = await currentAlpha2()
        return entries.enumerated().compactMap { index, entry in
            if isHidden(availability: entry.availability, countries: entry.countries, userAlpha2: userAlpha2) {
                return nil
            }
            // radiko full-auth rendering from featured is a follow-on; play the
            // direct url fallback only. No usable url ⇒ drop.
            guard let urlString = entry.url, !health.isDead(urlString),
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

- [ ] **Step 5: Pass health into the shelf builder**

In `current()` (around line 22), fetch health once and pass it. Replace:

```swift
        if let alpha2 = await currentAlpha2(),
           let stations = await stations(forAlpha2: alpha2), !stations.isEmpty {
```

with:

```swift
        let health = await StreamHealth.fetch()
        if let alpha2 = await currentAlpha2(),
           let stations = await stations(forAlpha2: alpha2, health: health), !stations.isEmpty {
```

(The bundled `globalDefault()` fallback is unchanged — it still serves the KR built-ins when offline / unmapped / empty.)

- [ ] **Step 6: Filter the "Feel Lucky" random pick**

In `RemoteStationCatalog.randomEntry()` (the second enum, around the `entries.randomElement()` line), drop dead URLs before picking. Replace:

```swift
        let entries = try JSONDecoder().decode([CatalogEntry].self, from: data)
        guard let pick = entries.randomElement() else { throw CatalogError.emptyCatalog }
```

with:

```swift
        let entries = try JSONDecoder().decode([CatalogEntry].self, from: data)
        let health = await StreamHealth.fetch()
        let live = entries.filter { !health.isDead($0.url) }
        guard let pick = (live.isEmpty ? entries : live).randomElement() else { throw CatalogError.emptyCatalog }
```

(`live.isEmpty ? entries` keeps Feel Lucky working even if health somehow nukes everything — fail open.)

- [ ] **Step 7: Build**

Open the project in Xcode and ⌘B. Expected: clean build. (`stations(forAlpha2:health:)` has a defaulted param so any other caller still compiles; `current()` and `randomEntry()` are already `async`.)

- [ ] **Step 8: Simulator sanity check**

⌘R. With a non-JP storefront, Explore → browse Japan: radiko/geo entries with `countries:["jp"]` don't appear; global JP entries do. Temporarily add a fake `{"name":"DeadTest","url":"https://dead.invalid/x"}`-style dead URL to `health.json`'s `unhealthy` (status `dead`) on a local server, or trust the unit test from Step 1 for the dead path. Confirm offline (airplane mode) still shows the bundled KR fallback.

- [ ] **Step 9: Commit**

```bash
cd /Users/moon/Projects/claude/kbscong
git add Shared/RemoteStationCatalog.swift
git commit -m "🌍 feat: fetch health.json + geo-filter featured (fail-open, bundled fallback)"
git push
```

---

## Phase 6 — Documentation

### Task 12: Document schema + health in featured/README.md

**Files:**
- Modify: `/Users/moon/Projects/claude/kradio/featured/README.md`

- [ ] **Step 1: Append the schema + pipeline section**

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
- **radiko** carries both `stationId` (subscribed auth via `RadikoAuthService`)
  and a fallback `url`; without a subscription the app plays the `url` best-effort.

## Health pipeline

Reachability is regenerated **weekly** by `.github/workflows/health-check.yml`:
`tools/probe-streams.mjs` probes the whole catalogue, `tools/build-health.mjs`
distils a compact `health.json` (a deny-list of non-healthy URLs; absent ⇒
healthy), and the Action commits it. The app fetches `health.json` from the CDN
and hides `dead` URLs (fail-open on error), keeping the bundled KR/UK/JP set as
the offline fallback. The probe runs from GitHub's US datacenter IPs (recorded
in `vantage`), so only hard-signal failures count as `dead`.

Geo/event availability on the curated set is produced occasionally (by hand) via
`tools/availability-classify.workflow.js` + `tools/apply-availability.mjs`.
See `docs/superpowers/specs/2026-06-06-stream-availability-design.md`.
```

- [ ] **Step 2: Commit + push**

```bash
cd /Users/moon/Projects/claude/kradio
git add featured/README.md
git commit -m "📚 docs: availability schema + weekly health pipeline in featured/README"
git push
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Operating model: weekly health + occasional availability | Phases 1–2 (health), 3–4 (availability) |
| `probe-classify.mjs` (dead/reachable/unknown, 403/451 geoHint, 5xx retry) | Tasks 1, 2 |
| `probe-streams.mjs` → `probe-report.{featured,full}.json` | Task 2 |
| `build-health.mjs` → compact `health.json` deny-list (+ vantage, guard) | Task 3 |
| `.github/workflows/health-check.yml` weekly cron, commits health.json | Task 5 |
| `prune-dead.mjs` occasional, hard-signal only | Task 4 |
| geo prior (conservative, radiko-only) + candidate select | Task 6 |
| classification Workflow (classify + adversarial + human review) | Tasks 8, 10 |
| `apply-availability.mjs` (atomic featured merge, radiko stationId+url) | Tasks 7, 10 |
| iOS health fetch (`StreamHealth`/`HealthList`, fail-open) | Task 11 (Steps 2,5,6) |
| iOS geo decode + filter (dead always; geo/event out-of-region; radiko url fallback; backward compat) | Task 11 (Steps 3,4) |
| iOS bundled KR/UK/JP fallback retained | Task 11 (Step 5 — `globalDefault()` untouched) |
| Datacenter-IP caveat → conservative dead, app hides only dead | Tasks 1 (classifier), 5 (vantage), 11 (only `dead` hidden) |
| health.json deny-list shape (absent ⇒ healthy) | Tasks 3, 11 |
| featured/README docs | Task 12 |
| Repo/file layout | matches File Structure |

**Type / name consistency:**
- `classifyReachability`/`isPrunable` exported (Task 1), imported by probe-streams (Task 2) + prune-dead (Task 4) ✓
- `toHealth` exported (Task 3), tested (Task 3) ✓
- probe record `{name,url,country,httpStatus,contentType,reachability,geoHint,signal,checkedAt,error?}` produced (Task 2), consumed by build-health (Task 3 reads reachability/signal/httpStatus/geoHint/url), geo-prior (Task 6 reads reachability/geoHint/url/name), prune (Task 4) ✓
- `geoPriorForUrl`/`selectGeoCandidates` exported (Task 6), used in Task 10 Step 2 ✓
- `mergeVerdict` (Task 7) consumes verdict `{url,availability,countries?,type?,stationId?}` = workflow output (Task 8) ✓
- health.json shape `{generatedAt,vantage,total,counts,unhealthy:[{url,status,signal,httpStatus,geoHint?}]}` produced (Task 3), decoded by iOS `HealthFile{unhealthy:[{url,status}]}` (Task 11) — iOS reads only the fields it needs ✓
- iOS `isHidden(availability:countries:userAlpha2:)` + `HealthList.isDead`/`normalize` identical in `/tmp` TDD (Task 11 Step 1) and the real code (Steps 2,3) ✓
- `stations(forAlpha2:health:)` defaulted param keeps existing callers compiling; `current()` passes health (Task 11 Steps 4,5) ✓
- Reachability/status vocabulary `dead|unknown|healthy(=reachable)` consistent across classifier, build-health, health.json, iOS ✓

**Placeholder scan:** No TBD/TODO/"similar to". Task 10 Step 3's "`<parsed JSON array from tools/candidates.json>`" is a concrete instruction (pass the file's array as Workflow `args`). Every code step has complete code.

Plan is clean.

---

## Execution Handoff

Plan saved to `/Users/moon/Projects/claude/kradio/docs/superpowers/plans/2026-06-06-stream-availability.md`.

Two execution options:

1. **Subagent-Driven (recommended for Phases 1, 3, 6)** — fresh subagent per tool task, review between. Phases 2/4/5 (Action validation, the probe + classification Workflow run + human-confirm, Xcode build/Simulator) stay in the main session.
2. **Inline Execution** — run here with checkpoints; fits the "verify and populate" ask since I run the probe + Workflow directly.

Which approach?
