# Featured stations by country

`<alpha2>.json` — a small, fame-ordered list of the most popular national radio
stations for that country, as `[{ "name", "url" }, …]` (most popular first).

Consumed by the app's **"Popular in <country>"** shelf: when the user's App
Store storefront isn't already covered by a built-in group (i.e. not Korea / UK
/ Japan / US), Oh My Radio fetches `https://kradio.nvis.io/featured/<cc>.json`
and shows it above the country groups. Tapping a row saves that station into the
country's group.

Generation: candidates come from `stations.json` (filtered by `country`,
deduped by name); the ranking by national fame/popularity is produced per
country and mapped back to the catalogue's exact stream URLs. Regenerate or
hand-edit any file to curate a country — the app picks up changes on next fetch
(no app update needed).

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
`tools/availability-classify.workflow.js` + `tools/apply-availability.mjs`, with
ambiguous cases recorded in `tools/availability-review.json`. See
`docs/superpowers/specs/2026-06-06-stream-availability-design.md`.

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
