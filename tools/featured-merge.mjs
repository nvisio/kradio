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
