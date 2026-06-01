# Featured stations by country

`<alpha2>.json` — a small, fame-ordered list of the most popular national radio
stations for that country, as `[{ "name", "url" }, …]` (most popular first).

Consumed by the app's **"Popular in <country>"** shelf: when the user's App
Store storefront isn't already covered by a built-in group (i.e. not Korea / UK
/ Japan / US), K-Radio Tuner fetches `https://kradio.nvis.io/featured/<cc>.json`
and shows it above the country groups. Tapping a row saves that station into the
country's group.

Generation: candidates come from `stations.json` (filtered by `country`,
deduped by name); the ranking by national fame/popularity is produced per
country and mapped back to the catalogue's exact stream URLs. Regenerate or
hand-edit any file to curate a country — the app picks up changes on next fetch
(no app update needed).
