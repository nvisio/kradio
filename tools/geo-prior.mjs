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
