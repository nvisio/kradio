# Channel B — Radio Browser station intake — Design

**Date**: 2026-06-06
**Status**: Approved (brainstorming → planning)
**Repo**: `nvisio/kradio` (public)
**Related**: extends the catalogue intake; complements the weekly health pipeline
(`docs/superpowers/specs/2026-06-06-stream-availability-design.md`).

## Goal

Grow and freshen the catalogue from an open upstream — the **Radio Browser**
community API (`api.radio-browser.info`, ~45–50k stations, CC0 data). Monthly,
automatically: fetch popular stations per country, add genuinely new ones to
`stations.json`, and union the top-voted ones into `featured/{cc}.json` — all
behind a **human-reviewed PR** (never auto-merged into the catalogue).

This is "Channel B" (scheduled upstream re-import). "Channel A" is user
submissions (already designed in `kradio-analytics`, not yet deployed).

## Non-Goals (deferred / out of scope)

- Automating **radio.garden** in the Action. radio.garden has no bulk
  per-country API; it stays a **manual** source via the existing
  `tools/import-radio-garden.mjs`, funnelling through the same
  diff → merge → index path. The monthly Action runs Radio Browser only.
- Proprietary directories (TuneIn / iHeart / myTuner / zeno.fm) — no open API,
  scraping violates ToS. Excluded.
- Updating/editing existing catalogue entries from RB (we are **append-only**:
  add net-new, never mutate or delete existing entries here). Removal of dead
  entries remains the occasional `prune-dead.mjs` job.
- Storing `stationuuid` / provenance in `stations.json` — entries stay clean
  `{name,url,country,genre,lang,city}` (repo dropped provenance in `b422814`).
  Dedup is stateless by URL (below), so no uuid state is needed.
- Calling RB's click-registration endpoint (`/json/url/{uuid}`) — that is a
  *player* concern (per-user plays), not the importer's; not in scope.

## Sources & cadence

| Source | Mechanism | Cadence | Target |
|---|---|---|---|
| **Radio Browser** | `/json/stations/search` per country, `order=votes` | **monthly** GitHub Action → PR | `stations.json` (net-new) + `featured/{cc}.json` (union) |
| radio.garden | existing `import-radio-garden.mjs` (manual, by id) | ad-hoc | `stations.json` |
| user submissions (Channel A) | `kradio-analytics` `/api/submit` (separate, not deployed) | event | `featured/{cc}.json` |

## Radio Browser API grounding (verified live during research)

- **Server discovery**: resolve `all.api.radio-browser.info` (or
  `GET /json/servers` → `[{ip,name}]`); pick a mirror hostname (e.g.
  `de1.api.radio-browser.info`), send data requests there, fail over on error.
  `all.api.*` is for discovery only — don't hammer it. (As of research it
  resolves to effectively one active mirror; build failover defensively.)
- **Fetch endpoint** (decisive):
  ```
  GET https://<mirror>/json/stations/search
        ?countrycode={CC}        # ISO 3166-1 alpha-2, UPPERCASE (KR, US, GB)
        &order=votes&reverse=true # most-voted first (votes is monotonic; clickcount fluctuates)
        &hidebroken=true          # MANDATORY (default false ships dead stations)
        &limit={K}&offset=0
  ```
- **User-Agent**: send `kradio/1.0 (+https://kradio.nvis.io)` on every request
  (the one real ask; some mirrors reject empty/generic UAs).
- **License**: CC0-equivalent (public domain). Commercial use OK, no attribution
  legally required. (AGPL applies only to self-hosting the server — N/A.)
- **No hard rate limit / no SLA** — cache, batch on schedule, retry+backoff,
  mirror failover. Be a good citizen.

## Field mapping: RB station → `{name,url,country,genre,lang,city}`

| Our field | RB source | Transform |
|---|---|---|
| `name` | `name` | trim |
| `url` | **`url_resolved`** (fallback `url` if empty) | the resolved/redirect-followed real stream |
| `country` | `countrycode` | **lowercase** (RB returns `KR`); never use free-text `country` |
| `genre[]` | `tags` | comma-separated **string** → split, trim, drop empties |
| `lang[]` | `languagecodes` (else `language`) | split on `,`, trim, lowercase |
| `city` | `state` | best-effort (region-level free text, often blank) |

## Quality pre-filter (client-side, after fetch)

Admit a station only if all hold:
- `lastcheckok === 1` (asserted in addition to `hidebroken=true`),
- `bitrate > 0` and non-empty `codec`,
- non-empty resolved URL,
- `url_resolved` (or `url`) scheme is `http`/`https`.

**Do NOT reject on `ssl_error === 1`** — a TLS error is not "offline" (consistent
with this repo's `cc17741` decision to treat TLS as "unknown", not "dead").

## Components

### 1. `tools/lib/radio-browser.mjs` — API client (network)
- `discoverMirror()` → a working `https://<mirror>` base (via `/json/servers`,
  with failover + UA).
- `fetchTopByCountry(base, cc, { limit })` → raw RB station array for one
  uppercase country code, `order=votes&reverse=true&hidebroken=true`.
- Retry-with-backoff; rotates mirror on failure.

### 2. `tools/rb-to-catalog.mjs` — pure mapping + filter (TDD)
- `mapStation(rb)` → `{ entry: {name,url,country,genre,lang,city}, ok: bool, reason }`
  applying the field map + quality filter above.
- `normUrl(u)` → normalized URL for dedup (lowercase, trim, strip trailing `/`).
- No network; fully unit-tested against fixtures.

### 3. `tools/featured-merge.mjs` — pure union (TDD)
- `unionFeatured(existing, incoming, cap)`:
  - keep **all** `existing` entries in order (preserves hand-curation +
    any `availability`/`countries`/`type` flags),
  - append `incoming` entries (RB top, `{name,url}`) whose `normUrl` is not
    already present, until total length reaches `cap`,
  - never truncate existing (if `existing.length >= cap`, append nothing).
- Returns the merged array; the harness writes it 2-space pretty (featured format).

### 4. `tools/import-radio-browser.mjs` — orchestrator
- Inputs: country set (default = the existing `featured/*.json` codes), `--limit K`
  (per-country fetch, default 500), `--featured-cap N` (default 50).
- For each `cc`: `fetchTopByCountry` → `mapStation` filter →
  - **catalogue growth**: entries whose `normUrl` ∉ current `stations.json` URL
    set → collect into `tools/rb-candidates.json` (net-new, pre-probe).
  - **featured union**: take the filtered top entries, `unionFeatured` with the
    current `featured/{cc}.json`, write the file (only if changed).
- Writes `tools/rb-candidates.json`; prints a per-country summary.

### 5. `tools/drop-dead-candidates.mjs` — tiny filter
- Reads `rb-candidates.json` + a probe report, drops entries whose reachability
  is `dead` (reuses `isPrunable` from `probe-classify.mjs`), writes the cleaned
  candidate list. (Insurance against RB's vantage differing from ours; the
  weekly `health.json` remains the ongoing safety net.)

### 6. `.github/workflows/import-stations.yml` — monthly CI → PR
Steps:
1. checkout + Node 22.
2. `node tools/import-radio-browser.mjs` → featured unions + `rb-candidates.json`.
3. `node tools/probe-streams.mjs tools/rb-candidates.json --out tools/probe-report.candidates.json --concurrency 40`.
4. `node tools/drop-dead-candidates.mjs` → cleaned candidates.
5. `node tools/enrich-stations.mjs <cleaned> --in-place` (fill any missing genre/lang).
6. `node tools/merge-stations.mjs stations.json <cleaned> --in-place` (URL dedup + compact format).
7. `node tools/build-index.mjs`.
8. **Open a PR** (e.g. `peter-evans/create-pull-request`) with the diff to
   `stations.json`, `stations.index.json`, `featured/*.json`. **Never auto-merge.**
   `cron: monthly` + `workflow_dispatch`. `probe-report*.json` stays gitignored.

### Reused tools (unchanged)
`probe-streams.mjs`, `enrich-stations.mjs`, `merge-stations.mjs` (URL dedup +
compact one-object-per-line format — the canonical `stations.json` format),
`build-index.mjs`.

## Data flow

```
monthly cron
  → import-radio-browser.mjs ──┬─► featured/{cc}.json  (unionFeatured, in place)
                               └─► tools/rb-candidates.json (net-new vs stations.json)
  → probe-streams (candidates) → drop-dead-candidates → enrich-stations
  → merge-stations → stations.json (dedup+compact) → build-index → stations.index.json
  → create-pull-request  (stations.json + index + featured/*.json)  ── human reviews & merges
```

## Dedup

- **Catalogue**: stateless by normalized `url_resolved` against the current
  `stations.json` URL set (and `merge-stations.mjs` dedups again on write). No
  `stationuuid` storage needed because we never update existing entries.
- **Featured**: `unionFeatured` dedups by `normUrl` against existing entries.
- RB has **no** server-side dedup and genuinely contains duplicates/junk tags —
  all dedup is our job. Never dedup on `name`+`country` (free-text, unreliable).

## Error handling

- `discoverMirror` fails over across mirrors; if all fail, the importer exits
  non-zero and the Action fails (no PR) — no partial/garbage commit.
- A single country's fetch failure is logged and skipped (others proceed); the
  run still produces a PR for the countries that succeeded.
- `mapStation` rejects (not throws) low-quality entries with a `reason`, tallied
  in the summary.
- `merge-stations` / `build-index` already guard their inputs; the PR step
  no-ops if nothing changed.

## Testing

- `rb-to-catalog.mjs`: unit-test `mapStation` (field map, lowercase country,
  comma-split tags/lang, url_resolved precedence, quality rejects, ssl_error not
  rejected) and `normUrl`.
- `featured-merge.mjs`: unit-test `unionFeatured` (preserve order + flags, append
  new only, dedup, cap behavior, existing ≥ cap → no append).
- `radio-browser.mjs`: thin network client — smoke-tested live in the plan
  (one country fetch) rather than unit-tested.
- Workflow validated by a manual `workflow_dispatch` after merge.

## Repo / file layout

| Path | Change |
|---|---|
| `tools/lib/radio-browser.mjs` | new (API client) |
| `tools/rb-to-catalog.mjs` (+`.test.mjs`) | new (pure map+filter) |
| `tools/featured-merge.mjs` (+`.test.mjs`) | new (pure union) |
| `tools/import-radio-browser.mjs` | new (orchestrator) |
| `tools/drop-dead-candidates.mjs` | new (tiny report filter) |
| `.github/workflows/import-stations.yml` | new (monthly → PR) |
| `tools/probe-report.candidates.json`, `tools/rb-candidates.json` | artifacts (gitignore) |
| `stations.json`, `stations.index.json`, `featured/*.json` | mutated via PR (not direct) |
| `tools/README.md` or `featured/README.md` | document the intake pipeline |

## Out of scope (future)

- Expanding beyond the featured country set to all RB countries.
- RB extended metadata (`has_extended_info`) for richer station info.
- Wiring RB click registration into the iOS player to contribute popularity.
- Auto-promoting catalogue stations into featured by our own click analytics.
