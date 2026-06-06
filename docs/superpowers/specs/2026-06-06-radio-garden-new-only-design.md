# radio.garden "new-only" top-up — Design

**Date**: 2026-06-06
**Status**: Approved (brainstorming → planning)
**Repo**: `nvisio/kradio`
**Related**: complements Channel B (`2026-06-06-channel-b-radio-browser-design.md`);
combined into the same first-import PR (#1, branch `bot/station-import-first`).

## Goal

Pull **only genuinely new** stations from radio.garden into the catalogue,
cheaply — without re-resolving the ~38k channels that are already in
`stations.json` (which was originally built *from* radio.garden). Add the delta
to PR #1 alongside the Radio Browser import.

## Key reality (drives the whole design)

radio.garden has **38,056 channels**; the catalogue was **37,793** before the RB
import and was sourced from radio.garden — so **radio.garden ≈ the catalogue**.
A naïve re-crawl resolves every channel (1 info GET + 1 stream-URL 302 each,
~0.6s) → **~3+ hours to re-discover dupes**. The net-new is at most a few hundred
(what radio.garden added since the original import). So the design must find that
delta **without paying the resolve cost on dupes**.

## Approach: two-stage dedup ("new-only")

The expensive step is resolving a channel's stream URL (the 302 follow); dedup is
by URL, which seems to require resolving everything. Avoid it with a cheap
**name pre-filter** before resolving:

```
listPlaces (1 request) → places [{country, size, id}]
  → for each place: expandPlace (1 request) → [{channelId, title}]   # NO resolve
  → STAGE 1 dedup (cheap): drop channels whose normalized name+country is
      already in the catalogue. (Catalogue came from radio.garden, so titles
      match → most dupes are dropped here, unresolved.)
  → resolve ONLY the name-novel survivors (302) → stream URL
  → STAGE 2 dedup (authoritative): drop any whose normalized URL is already
      in the catalogue → net-new candidates
  → probe-streams → drop-dead-candidates → enrich-stations
  → merge-stations → stations.json → build-index
  → commit on bot/station-import-first → push → PR #1 updates
```

Cost = `listPlaces` (1) + `expandPlace` per place + resolves only for
name-novel channels (a small minority). Bounded by `--max-resolve` (default
3000) as a hard safety cap.

## radio.garden API (verified live)

- `GET /api/ara/content/places` → `data.list: [{ id, title, country, size, geo, url }]`
  (12,626 places; `size` = channel count; `country` = display name).
- `GET /api/ara/content/page/{placeId}/channels` → sections of items; each
  `item.page.url` = `/listen/<slug>/<channelId>` and carries the channel `title`.
- `GET /api/ara/content/listen/{channelId}/channel.mp3?type=channel` → 302 to the
  broadcaster's real stream (radio.garden's CDN 403s non-browser UAs, so we
  follow the redirect to the direct URL — same as the existing importer).
- UA: `kradio-importer/1.0 (+https://kradio.nvis.io)` (existing convention).
- Polite sequential calls with a short sleep (existing importer uses 250–300ms).

## Field mapping (unchanged from existing importer)

`{ name: channel title, url: resolved stream, country: countryCodeFrom(place
country name), genre: [] (radio.garden has none → enrich fills), lang: [] (enrich
fills), city: place title }`.

## Components

### 1. `tools/lib/radio-garden.mjs` — extracted + upgraded shared lib
Move the reusable functions out of `import-radio-garden.mjs` into a lib so both
the existing CLI and the new "new-only" tool share them (DRY):
- `listPlaces()` → place list (NEW — wraps `/places`).
- `expandPlaceItems(placeId)` → `[{ channelId, title }]` (extends the existing
  `expandPlace`, which currently returns ids only, to also return titles).
- `resolveListenURL(channelId)`, `channelInfo(channelId)` (moved as-is).
- **`countryCodeFrom(name)` upgraded**: build a name→alpha-2 map by inverting
  `Intl.DisplayNames(['en'],{type:'region'})` over all ISO codes, plus the
  existing alias table as fallback. Covers ~200 countries (the current ~50-entry
  table misses most thin countries).
- Pure `nameKey(name, country)` → normalized dedup key, and
  `isKnown(nameKey, knownSet)`.
Refactor `import-radio-garden.mjs` to import these (verify the CLI still works).

### 2. `tools/import-rg-new.mjs` — the new-only orchestrator
- Load `stations.json`; build a `knownNameKeys` set (`nameKey(name,country)`) and
  a `knownUrls` set (`normUrl`).
- `listPlaces` → optionally restrict by `--countries` (default: all).
- For each place: `expandPlaceItems` → for each channel, compute
  `nameKey(title, countryCodeFrom(place.country))`; **skip if in `knownNameKeys`**.
- Resolve survivors (respecting `--max-resolve`), `normUrl`, skip if in
  `knownUrls`; collect net-new `{name,url,country,genre:[],lang:[],city}`.
- Write `tools/rg-candidates.json`; print a summary (places scanned, name-dupes
  skipped, resolved, net-new).
- Flags: `--max-resolve N` (default 3000), `--countries cc,..`, `--dry-run`.

### 3. Reused downstream (same as RB Channel B)
`probe-streams.mjs` → `drop-dead-candidates.mjs`
(`--candidates tools/rg-candidates.json`) → `enrich-stations.mjs --in-place` →
`merge-stations.mjs stations.json tools/rg-candidates.json --in-place` →
`build-index.mjs`.

## Data flow

```
import-rg-new.mjs ─► tools/rg-candidates.json (net-new, name+URL deduped)
  → probe-streams → drop-dead-candidates → enrich-stations
  → merge-stations → stations.json (on bot/station-import-first, already +RB)
  → build-index → push → PR #1 (now RB + radio.garden)
```

## Error handling

- A place whose `expandPlaceItems` fails is logged and skipped (others proceed).
- A channel whose resolve fails is logged and skipped (not added).
- `--max-resolve` cap prevents an unexpectedly large resolve set; the run logs
  if the cap was hit (so we know coverage was bounded).
- Network politeness: sequential with sleeps; UA set.

## Testing

- `tools/lib/radio-garden.mjs`: unit-test the pure parts — upgraded
  `countryCodeFrom` (e.g. "South Korea"→kr, "Germany"→de, "Bulgaria"→bg,
  unknown→null), `nameKey` normalization, `isKnown`.
- The network functions (`listPlaces`, `expandPlaceItems`, `resolveListenURL`)
  are smoke-tested live in the plan (one place), not unit-tested.
- The existing `import-radio-garden.mjs` CLI is re-verified (`--help` + a 1-channel
  `--dry-run`) after the refactor.

## Repo / file layout

| Path | Change |
|---|---|
| `tools/lib/radio-garden.mjs` (+`.test.mjs`) | new (extracted + upgraded; pure parts tested) |
| `tools/import-radio-garden.mjs` | refactor to import from the lib (behavior unchanged) |
| `tools/import-rg-new.mjs` | new (new-only orchestrator) |
| `tools/rg-candidates.json` | artifact (gitignore) |
| `stations.json`, `stations.index.json` | mutated on `bot/station-import-first` → PR #1 |

## Non-goals

- Touching `featured/*.json` from radio.garden — no popularity signal; RB owns
  featured ranking.
- Adding radio.garden to the **monthly Action** — it stays a manual/occasional
  run (this tool), consistent with the Channel B decision.
- Storing channel IDs / provenance in `stations.json` (entries stay clean).
- Re-resolving existing entries to refresh their URLs (separate concern).

## Out of scope (future)

- Persisting a radio.garden channel-id → url map to make future delta runs even
  cheaper (skip name pre-filter).
- Periodic scheduled radio.garden delta runs.
