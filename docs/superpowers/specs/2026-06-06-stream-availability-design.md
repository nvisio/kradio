# Stream Availability — Design

**Date**: 2026-06-06
**Status**: Approved (brainstorming → planning)
**Repos**:
- Public: `nvisio/kradio` — schema, probe tools, featured data, dead cleanup
- iOS (private): `kbscong` — decode availability + geo-filter the featured shelf

## Goal

Give the worldwide catalogue a small, honest availability model: most stations
are globally playable, and the exceptions (geo-locked, event-only, dead) are
flagged. Verify the flags by actually probing streams, and have the iOS app
hide stations a user can't play. Establish a schema that can also *represent*
radiko stations (without populating them yet).

Default stance, per the user's framing: **assume global; flag only the
exceptions.**

## Operating Model: Automated Health Pipeline

Health is not a one-time manual run — it is a **weekly automated pipeline**.
Two distinct layers, regenerated on different cadences:

| Layer | What | Cadence | Engine | Output |
|---|---|---|---|---|
| **Health** (reachability) | dead / unknown / healthy for the whole 37k catalogue | **weekly**, GitHub Actions cron | `probe-streams.mjs` (deterministic, LLM-free) | `health.json` (served via Pages/CDN) |
| **Availability** (geo/event) | geo_restricted / event_based on the curated featured set | **occasional**, run by hand | LLM classify + adversarial Workflow | annotations in `featured/{cc}.json` |

Pipeline (the user's 5 steps, mapped):

1. **Catalogue in the GitHub repo** — `nvisio/kradio` already holds
   `stations.json` + `featured/{cc}.json`. (done)
2. **Weekly health check via GitHub Actions** —
   `.github/workflows/health-check.yml` runs `probe-streams.mjs` over
   `stations.json` on a weekly cron.
3. **Status JSON generated** — `build-health.mjs` distils the probe report into
   `health.json` and the Action commits it. The catalogue itself is *not*
   mutated (curation stays human; health is a separate regenerated layer).
4. **App fetches catalogue + health from CDN** — the app reads
   `stations.json` / `featured/{cc}.json` and `health.json` from
   `https://kradio.nvis.io/…` (GitHub Pages CDN) and filters at runtime.
5. **App bundles only a fallback list** — the existing built-in KR/UK/JP
   stations remain bundled as the offline / fetch-failure fallback; the
   remote catalogue is the primary source.

**Datacenter-IP caveat (important).** GitHub Actions runners are US datacenter
IPs (Azure). Many radio CDNs return 403 or block datacenter IPs, so a CI health
check sees **more false-403 / false-dead than a residential probe**. Mitigation:
`dead` is restricted to **hard** signals (DNS NXDOMAIN, conn refused, TLS
invalid, 404, 410); 403/451 are `unknown`+`geoHint`, never `dead`; timeouts and
5xx are `unknown`. The app treats only `dead` as a hard hide; `unknown` stays
visible (best-effort). Weekly (not daily) cadence is also politeness toward
broadcasters.

## health.json

A separate status layer keyed by URL, regenerated weekly and served from the
CDN. To stay small over 37k entries it lists only the **non-healthy** URLs;
**any URL absent from the file is healthy**.

```jsonc
{
  "generatedAt": "2026-06-06T03:00:00Z",
  "vantage": "github-actions-us",      // honesty: where the probe ran from
  "total": 37793,
  "counts": { "healthy": 35120, "unknown": 2310, "dead": 363 },
  "unhealthy": [
    { "url": "https://dead.example/s.mp3", "status": "dead",    "signal": "ENOTFOUND",  "httpStatus": null },
    { "url": "https://geo.example/s.mp3",  "status": "unknown", "signal": "http_403", "httpStatus": 403, "geoHint": true }
  ]
}
```

App rule: a catalogue/featured URL present in `unhealthy` with `status:"dead"`
is hidden; `status:"unknown"` is kept (best-effort, may be a datacenter-IP false
negative). This deny-list shape keeps the file to the few thousand non-healthy
rows instead of all 37k.

## Non-Goals (deferred follow-ons)

- The **subscription-gated** radiko-auth rendering from featured (using
  `stationId` + the token dance) and populating `featured/jp.json` with actual
  radiko stations are a separate project. *(In scope here: the schema holds
  radiko, and the **non-subscription `url` fallback** path works — a radiko
  entry with a `url` plays best-effort like any direct entry.)*
- A `category` field (overlaps the existing `genre`; not needed here).
- Showing geo-locked stations as "disabled + JP-only badge" instead of hiding
  them (UI refinement).
- Multi-region probing to overcome the single-vantage limitation.
- Applying geo/event **availability** metadata to the 37k `stations.json` — the
  full catalogue gets only the **health** layer (reachability via `health.json`);
  geo/event stays on the curated featured set.

## Constraints & Realities (discovered in code)

- `featured/{cc}.json` is `[{name, url}]` today; the iOS `FeaturedEntry`
  decoder reads only `name` + `url`, so **extra JSON fields are silently
  ignored** — additive schema is backward-compatible.
- `stations.json` (37,793 entries) is generated; `build-index.mjs` ignores
  unknown keys; `merge-stations.mjs` preserves whole objects.
- `featured/` is *derived from* `stations.json` (filtered by country, ranked),
  not merged into it — they are separate artifacts.
- **radiko degrades gracefully — it is two paths, not one.** The full radiko
  path needs the auth1→auth2 token dance (`RadikoAuthService` already exists in
  the app), per-segment headers (`X-Radiko-AuthToken`, `X-Radiko-AreaId`), and
  is keyed by `stationID` + area. That path is **subscription-gated**: only when
  the app's radiko/subscription auth is available does it use
  `type:"radiko"` + `stationId`. When there is **no subscription**, the app
  must fall back to a plain direct URL and simply *attempt* the connection
  (best-effort, may succeed in-area or fail). Therefore a radiko featured entry
  carries **both** `stationId` (for the subscribed auth path) **and** a `url`
  (the direct fallback for non-subscribers). The `geo_restricted` metadata
  describes availability correctly but is independent of which playback path is
  used.
- **Single-vantage probing limitation.** Probes run from one location
  (currently Europe). A single vantage point can reliably detect `dead` (hard
  failures) and `reachable` candidates, but **cannot** reliably distinguish
  `geo_restricted` from `global`, nor confirm `event_based`. Therefore: the
  script owns dead/reachable; geo/event is decided by a knowledge layer
  (broadcaster domains + LLM reasoning + adversarial verification), not by the
  probe alone. Dead-cleanup on the 37k set is restricted to **hard** signals so
  a Korea-only stream that merely fails from Europe is never pruned.

## Schema

```ts
type StreamAvailability =
  | "global"          // default when the field is absent
  | "geo_restricted"
  | "event_based"
  | "unknown"
  | "dead";

// featured/{cc}.json entry — every added field is OPTIONAL; only exceptions
// carry them. Global entries stay exactly `{ name, url }`.
interface FeaturedEntry {
  name: string;
  url?: string;                       // direct stream URL; also the FALLBACK for radiko entries
  type?: "direct" | "radiko";         // absent ⇒ "direct"
  stationId?: string;                 // present when type === "radiko" (subscribed auth path)
  availability?: StreamAvailability;  // absent ⇒ "global"
  countries?: string[];               // lowercase alpha-2; meaningful for geo_restricted / event_based
}
```

Design rules:
- Backward compatible: `name`/`url` keep their names (renaming `url`→`streamUrl`
  would break the shipped app).
- No redundant `geoRestricted` boolean — derivable from `availability`.
- Annotate exceptions only; absent `availability` ⇒ `global`.
- `countries` lists where a geo/event station *is* available.
- **radiko entries should carry both** `stationId` and a fallback `url`. With a
  subscription, the app uses the `stationId` radiko-auth path; without one, it
  stores the `url` as a direct source and attempts the connection. A radiko
  entry with neither a usable subscription path nor a `url` is unplayable and is
  dropped by the client.

## Probe Evidence Sidecar

Raw probe results do not pollute `featured/` or the committed catalogue. They
live in `tools/probe-report.{featured,full}.json` (gitignored — large), one
record per probed stream. The committed, CDN-served distillation is
`health.json` (above); the raw report is the intermediate the tools read.

```jsonc
{
  "name": "Sportschau Bundesliga Konferenz",
  "url": "https://dispatcher.rndfnk.com/.../stream.mp3",
  "country": "de",
  "httpStatus": 403,
  "contentType": null,
  "reachability": "unknown",   // dead | reachable | unknown
  "geoHint": true,             // 403/451 seen
  "checkedAt": "2026-06-06T...Z",
  "error": null
}
```

`featured/` carries only the distilled `availability` / `countries` / `type`.

## Components

### 1. `tools/probe-streams.mjs` — deterministic reachability (source of truth)

Reused for both the featured set and the full 37k catalogue. LLM-free.

- Concurrency ~20 (simple in-house limiter, no new deps), `GET` with
  `Range: bytes=0-1` and a HEAD fallback, 8s timeout, ≤3 redirects.
- Classification:
  - **dead** — DNS NXDOMAIN, ECONNREFUSED, TLS-invalid, HTTP 404, 410, or 5xx
    after one retry.
  - **reachable** — 2xx with audio-ish content-type
    (`audio/mpeg`, `audio/aac`, `audio/ogg`, `application/vnd.apple.mpegurl`,
    `application/octet-stream` with audio bytes) or a readable byte stream.
  - **unknown** — timeout, 401/403/451, redirect loop, ambiguous type.
    `403`/`451` set `geoHint: true`.
- Usage:
  - `node tools/probe-streams.mjs --featured` → probes every `featured/*.json`
    entry, writes `tools/probe-report.featured.json`.
  - `node tools/probe-streams.mjs stations.json` → probes the full catalogue,
    writes `tools/probe-report.full.json` (the weekly Action path).

### 2. Classification workflow — geo/event judgment (LLM + adversarial)

Runs only over **reachable** featured entries (a few hundred). Implemented as a
Workflow (ultracode). Hybrid #3:

- A seed `GEO_BROADCASTERS` table is a strong prior, e.g.
  `radio.bsod.kr` neutral; `radiko.jp → jp (+type:radiko)`;
  `*.ard.de / wdr / swr / ndr / br / mdr / rbb / dlf / rndfnk → de` (public,
  often geo-fenced); `bbc.co.uk / *.akamaized.net bbc → gb`;
  `radiofrance / francetv → fr`; `rai.it → it`; `rtve.es → es`; etc.
- **Stage 1 (classify):** pipeline by country; an agent classifies each reachable
  station as `global | geo_restricted | event_based`, grounded in the probe
  record (`geoHint`/403 = strong signal) and the domain prior, **with a written
  reason**. Conservative: default `global` unless a strong signal.
- **Stage 2 (adversarial verify):** for each non-global verdict, independent
  agents try to **refute** it ("is this actually globally playable?"). A
  restriction survives only on a majority. This guards against hallucinated
  geo-locks.
- **Ambiguous / split verdicts** → emitted to a human-confirm list
  (`tools/availability-review.json`), NOT auto-applied.
- Confirmed verdicts are merged into `featured/{cc}.json` as `availability` +
  `countries` (and `type`/`stationId` where the prior says radiko).

### 3. `tools/build-health.mjs` — distil probe report → `health.json`

- Reads `tools/probe-report.full.json`, emits `health.json` (deny-list shape
  above): metadata + the `unhealthy` array (every record whose reachability is
  `dead` or `unknown`). Healthy URLs are omitted.
- Refuses to write if the report is missing or smaller than a sanity threshold
  (guards against a truncated/failed probe overwriting a good `health.json`).
- This is what the weekly Action commits.

### 4. `.github/workflows/health-check.yml` — weekly CI

- `schedule: cron` weekly (plus `workflow_dispatch` for manual runs).
- Steps: checkout → setup Node 22 → `node tools/probe-streams.mjs stations.json
  --concurrency 40` → `node tools/build-health.mjs` → commit `health.json` if it
  changed (`git diff --quiet || git commit`). `probe-report.full.json` stays
  gitignored (not committed); only `health.json` is.
- Records `vantage: "github-actions-us"` in the output for honesty about where
  the probe ran.

### 5. `tools/prune-dead.mjs` — occasional hard compaction (NOT in the weekly Action)

The primary mechanism is `health.json` + runtime filtering, so the catalogue is
**not** mutated weekly. This tool stays available for an *occasional* manual
compaction that physically removes long-dead entries from `stations.json`:

- Removes only `dead`-by-hard-signal entries (`DNS NXDOMAIN`, `conn refused`,
  `404`, `410`, `TLS invalid`). Timeouts, 403, 5xx kept.
- Re-runs `build-index.mjs` afterward. Run by hand when the dead set has grown,
  not on a schedule.

### 6. iOS — `kbscong/Shared/RemoteStationCatalog.swift`

**Health fetch + fallback (the user's steps 4–5):**
- Fetch `https://kradio.nvis.io/health.json` (cached, ~weekly TTL) into a
  `HealthList` value: a `Set<String>` of dead URLs (normalised) built from
  `unhealthy` rows where `status == "dead"`. `unknown` rows are **not** added
  (kept visible — datacenter-IP false negatives).
- When rendering the featured shelf (and the "Feel Lucky" random pick from
  `stations.json`), drop any URL in the dead set.
- **Fallback:** the existing bundled `koreaStations` / `ukStations` /
  `japanStations` remain the offline / fetch-failure fallback (see
  `globalDefault()`); the remote catalogue + `health.json` are the primary
  source. If `health.json` can't be fetched, skip health filtering (fail open —
  show everything) rather than hiding the catalogue.

**Availability (geo/event) decode + filter:**
- Extend `FeaturedEntry`:
  ```swift
  struct FeaturedEntry: Decodable {
      let name: String
      let url: String?
      let type: String?           // "direct" | "radiko"
      let availability: String?   // StreamAvailability raw
      let countries: [String]?
      let stationId: String?
  }
  ```
- Visibility rules in `stations(forAlpha2:)`, comparing the user's storefront
  alpha2 against `countries`:
  - `availability == "dead"` → always drop.
  - `availability ∈ {geo_restricted, event_based}` and user alpha2 ∉
    `countries` → drop. (Key for the Explore sheet, where a user browses other
    countries' featured lists.)
  - `type == "radiko"`:
    - subscription / radiko-auth available → use the radiko source
      (`stationId`). *(Full radiko-auth rendering from featured is the H
      follow-on; the decode branch + the decision point land here.)*
    - otherwise → if `url` present, store as `.directURL(url)` and attempt the
      connection (best-effort); if no `url`, drop (the existing `compactMap` on
      a nil URL already does this safely).
  - absent `availability` → treated as `global` → show (backward compatible).
- The storefront alpha2 is already available via `currentAlpha2()`; the Explore
  path passes the browsed country's alpha2 — visibility compares against the
  *user's* storefront, which `RegionalStations` already knows.

## Data Flow

```
WEEKLY (GitHub Actions, automated, LLM-free):
  cron ─► probe-streams.mjs stations.json ─► probe-report.full.json (gitignored)
                                                   │
                                                   ▼
                                          build-health.mjs ─► health.json ─► commit ─► Pages/CDN
                                                                                          │
OCCASIONAL (by hand, LLM):                                                                │
  probe-streams.mjs --featured ─► probe-report.featured.json                              │
                                       │ selectGeoCandidates                              │
                                       ▼                                                  │
                                 classification WF (classify + adversarial)               │
                                       │ verdicts (+ human-confirm review)                │
                                       ▼                                                  │
                                 apply-availability.mjs ─► featured/{cc}.json             │
                                                                  │                       │
                                                                  ▼                       ▼
  iOS RemoteStationCatalog ◄──── featured/{cc}.json (geo/event) + health.json (dead set) + bundled fallback
                          └─► geo-filtered + health-filtered "Popular in <country>" shelf
```

## Error Handling

- Probe failures never crash the run; each becomes a record with an `error`
  string and `reachability: dead|unknown` per the rules above.
- The classification workflow tolerates dead agents (filter nulls); any entry
  with no surviving verdict defaults to `global` (conservative) and is added to
  the human-confirm list.
- `prune-dead.mjs` refuses to write if the report is missing or smaller than a
  sanity threshold (guards against pruning on a truncated report).
- iOS decoding is lenient: unknown `availability` strings fall through to
  "show" (treated as global); a malformed entry is dropped by `compactMap`.

## Testing

- `tools/probe-streams.mjs`: unit-test the **classifier** (pure function
  `classify({status, contentType, error})` → reachability) against a table of
  fixtures; mock fetch for a few integration cases.
- `tools/prune-dead.mjs`: unit-test the hard-dead predicate; test that
  timeouts/403/5xx are retained.
- iOS: a decode test (golden JSON with mixed entries) + a filter test
  (storefront ∈/∉ countries → shown/hidden; dead always hidden; radiko/no-url
  dropped; absent-availability shown).
- The classification workflow's adversarial stage is its own correctness check.

## Repo / File Layout

| Repo | Path | Change |
|---|---|---|
| nvisio/kradio | `tools/probe-classify.mjs` (+test) | new (pure classifier) |
| nvisio/kradio | `tools/probe-streams.mjs` | new (probe → report) |
| nvisio/kradio | `tools/build-health.mjs` | new (report → `health.json`) |
| nvisio/kradio | `tools/geo-prior.mjs` (+test) | new (prior + candidate select) |
| nvisio/kradio | `tools/apply-availability.mjs` (+test) | new (verdicts → featured) |
| nvisio/kradio | `tools/availability-classify.workflow.js` | new (LLM classify + adversarial) |
| nvisio/kradio | `tools/prune-dead.mjs` | new (occasional hard compaction) |
| nvisio/kradio | `.github/workflows/health-check.yml` | new (weekly cron) |
| nvisio/kradio | `health.json` | committed status layer (served via CDN) |
| nvisio/kradio | `tools/probe-report*.json` | artifacts (gitignore) |
| nvisio/kradio | `tools/availability-review.json` | human-confirm list (commit — audit trail) |
| nvisio/kradio | `featured/*.json` | exception entries annotated |
| nvisio/kradio | `featured/README.md` | document new fields + StreamAvailability |
| nvisio/kradio | `.gitignore` | add `tools/probe-report*.json` |
| nvisio/kradio | `docs/superpowers/specs/2026-06-06-stream-availability-design.md` | this spec |
| kbscong | `Shared/RemoteStationCatalog.swift` | health fetch + fallback + geo decode/filter |

## Execution Note

Two cadences, not one:
- **Stand up the weekly pipeline** (build the tools + Action) so health
  regenerates itself: probe → `build-health.mjs` → commit `health.json`. After
  the first Action run, `health.json` is live on the CDN.
- **Populate availability once now** ("직접 확인해서 flag를 넣어줘"): probe
  featured → classify (Workflow) → human-confirm → `apply-availability.mjs` →
  commit `featured/*.json`. Re-run occasionally, not on a schedule.
- iOS consumes both layers + keeps the bundled KR/UK/JP fallback.
