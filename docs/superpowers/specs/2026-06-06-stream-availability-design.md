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

## Non-Goals (deferred follow-ons)

- Populating `featured/jp.json` with actual radiko stations (schema supports it;
  data + iOS radiko rendering from featured is a separate project).
- A `category` field (overlaps the existing `genre`; not needed here).
- Showing geo-locked stations as "disabled + JP-only badge" instead of hiding
  them (UI refinement).
- Multi-region probing to overcome the single-vantage limitation.
- Applying full availability metadata to the 37k `stations.json` (only dead
  cleanup there).

## Constraints & Realities (discovered in code)

- `featured/{cc}.json` is `[{name, url}]` today; the iOS `FeaturedEntry`
  decoder reads only `name` + `url`, so **extra JSON fields are silently
  ignored** — additive schema is backward-compatible.
- `stations.json` (37,793 entries) is generated; `build-index.mjs` ignores
  unknown keys; `merge-stations.mjs` preserves whole objects.
- `featured/` is *derived from* `stations.json` (filtered by country, ranked),
  not merged into it — they are separate artifacts.
- **radiko is not a URL.** It needs the auth1→auth2 token dance
  (`RadikoAuthService` already exists in the app), per-segment headers
  (`X-Radiko-AuthToken`, `X-Radiko-AreaId`), and is keyed by `stationID` + area.
  So representing radiko needs a `type` discriminator + `stationId`, not a
  `url`. The `geo_restricted` metadata describes it correctly but is not
  sufficient to play it.
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
  url?: string;                       // omittable only when type needs an id-based source
  type?: "direct" | "radiko";         // absent ⇒ "direct"
  stationId?: string;                 // present when type === "radiko"
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

## Probe Evidence Sidecar

Raw probe results do not pollute `featured/`. They live in
`tools/probe-report.json` (gitignored — large), one record per probed stream:

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
    entry, writes `tools/probe-report.json`.
  - `node tools/probe-streams.mjs stations.json` → probes the full catalogue.

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

### 3. `tools/prune-dead.mjs` — conservative 37k cleanup

- Reads `probe-report.json`, removes from `stations.json` only entries whose
  reachability is `dead` by **hard signals** (`DNS NXDOMAIN`, `conn refused`,
  `404`, `410`, `TLS invalid`). Timeouts, 403, and 5xx are **kept** (could be
  geo or transient).
- Re-runs `build-index.mjs` afterward.
- Prints a summary: probed N, hard-dead M, pruned M, kept-unknown K.

### 4. iOS — `kbscong/Shared/RemoteStationCatalog.swift`

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
  - `type == "radiko"` (no playable `url`) → drop for now (the existing
    `compactMap` on a nil URL already does this safely).
  - absent `availability` → treated as `global` → show (backward compatible).
- The storefront alpha2 is already available via `currentAlpha2()`; the Explore
  path passes the browsed country's alpha2 — visibility compares against the
  *user's* storefront, which `RegionalStations` already knows.

## Data Flow

```
probe-streams.mjs  ──►  tools/probe-report.json
        │                      │
        │ (featured reachables)│ (full catalogue, hard-dead)
        ▼                      ▼
  classification WF      prune-dead.mjs ──► stations.json (pruned) ──► build-index.mjs
   (LLM + adversarial)         
        │
        ▼
  featured/{cc}.json  (availability / countries / type on exceptions)
        │
        ▼
  iOS RemoteStationCatalog  ──► geo-filtered "Popular in <country>" shelf
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
| nvisio/kradio | `tools/probe-streams.mjs` | new (probe → report) |
| nvisio/kradio | `tools/prune-dead.mjs` | new (conservative 37k prune) |
| nvisio/kradio | `tools/probe-report.json` | artifact (gitignore) |
| nvisio/kradio | `tools/availability-review.json` | human-confirm list (gitignore or commit small) |
| nvisio/kradio | `featured/*.json` | exception entries annotated |
| nvisio/kradio | `featured/README.md` | document new fields + StreamAvailability |
| nvisio/kradio | `.gitignore` | add probe-report.json |
| nvisio/kradio | `docs/superpowers/specs/2026-06-06-stream-availability-design.md` | this spec |
| kbscong | `Shared/RemoteStationCatalog.swift` | decode + geo-filter |

## Execution Note

The user explicitly wants the flags actually populated ("직접 확인해서 flag를
넣어줘"), so the implementation phase ends in a real run: probe → classify
(workflow) → merge into featured → conservative prune → rebuild index, then the
iOS decode/filter change. The classification step is the ultracode Workflow.
