// tools/probe-classify.mjs
// Pure reachability classifier. No network, no side effects.
//
//   "dead"      — unambiguous, environment-independent removal (DNS NXDOMAIN,
//                 conn refused, 410 Gone). Exactly the set safe to prune /
//                 hard-hide. NOTE: 404 is deliberately NOT here — many
//                 geo-restricted streams return 404 to an out-of-region probe,
//                 so a single-vantage 404 would falsely hard-hide a station that
//                 plays fine for its own users (→ "unknown" instead).
//   "reachable" — 2xx with an audio-ish content-type.
//   "unknown"   — everything else (timeout, reset, 5xx, 401/403/404/451, other
//                 4xx, 2xx non-audio). 403/451 set geoHint.

const AUDIO_TYPES = [
  "audio/",
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/ogg",
  "application/octet-stream",
];

// Only unambiguous, environment-independent failures are "dead". TLS errors are
// deliberately NOT here: a Node probe over-reports them (incomplete cert chains
// it won't fetch, CA-bundle/SNI quirks) on streams iOS plays fine, so TLS →
// "unknown" (kept visible) rather than hard-hidden.
const HARD_DEAD_ERRORS = new Set(["ENOTFOUND", "ECONNREFUSED"]);

export function classifyReachability({ status = null, contentType = null, errorCode = null } = {}) {
  if (errorCode) {
    if (HARD_DEAD_ERRORS.has(errorCode)) {
      return { reachability: "dead", geoHint: false, signal: errorCode };
    }
    return { reachability: "unknown", geoHint: false, signal: errorCode };
  }
  if (status === 410) {
    // 410 Gone is a definitive, environment-independent removal — safe to hard-hide.
    return { reachability: "dead", geoHint: false, signal: "http_410" };
  }
  if (status === 403 || status === 451) {
    return { reachability: "unknown", geoHint: true, signal: `http_${status}` };
  }
  if (status === 404) {
    // 404 is ambiguous from a single probe vantage: many geo-restricted streams
    // (e.g. RTBF, regional/national CDNs) return 404 to out-of-region requests,
    // so treating it as "dead" would hard-hide a live station from the very
    // users who can play it. Keep it visible like other ambiguous 4xx.
    return { reachability: "unknown", geoHint: false, signal: "http_404" };
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
