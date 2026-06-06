// tools/lib/radio-browser.mjs
// Minimal Radio Browser API client: discover a mirror, fetch top stations
// per country by votes. Sends a descriptive User-Agent (the one real ask).

const UA = "kradio/1.0 (+https://kradio.nvis.io)";
const DISCOVERY = "https://all.api.radio-browser.info/json/servers";

async function getJSON(url, timeout = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Returns an ordered list of mirror base URLs (https://<name>); falls back to
// known hosts if discovery fails.
export async function discoverMirrors() {
  try {
    const servers = await getJSON(DISCOVERY);
    const names = [...new Set((servers || []).map((s) => s.name).filter(Boolean))];
    const bases = names.map((n) => `https://${n}`);
    if (bases.length) return bases;
  } catch { /* fall through */ }
  return ["https://de1.api.radio-browser.info", "https://all.api.radio-browser.info"];
}

// Fetch top stations for one UPPERCASE alpha-2 country code, ordered by votes.
// Tries each mirror until one succeeds.
export async function fetchTopByCountry(mirrors, cc, { limit = 500 } = {}) {
  const qs = new URLSearchParams({
    countrycode: cc.toUpperCase(),
    order: "votes",
    reverse: "true",
    hidebroken: "true",
    limit: String(limit),
    offset: "0",
  });
  let lastErr;
  for (const base of mirrors) {
    try {
      return await getJSON(`${base}/json/stations/search?${qs}`);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`all mirrors failed for ${cc}: ${lastErr?.message || "unknown"}`);
}
