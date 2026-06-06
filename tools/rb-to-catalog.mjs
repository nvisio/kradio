// tools/rb-to-catalog.mjs
// Pure mapping + quality filter: Radio Browser station → catalogue entry.
// No network. Unit-tested.

export function normUrl(u) {
  return (u || "").trim().toLowerCase().replace(/\/+$/, "");
}

function splitCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// rb: a Radio Browser station object.
// Returns { ok, reason?, entry } — entry is {name,url,country,genre,lang,city}.
export function mapStation(rb) {
  const url = (rb.url_resolved && rb.url_resolved.trim()) || (rb.url || "").trim();
  const reasons = [];
  if (rb.lastcheckok !== 1) reasons.push("lastcheckok");
  if (!(Number(rb.bitrate) > 0)) reasons.push("bitrate");
  if (!String(rb.codec || "").trim()) reasons.push("codec");
  if (!url) reasons.push("no_url");
  else if (!/^https?:\/\//i.test(url)) reasons.push("bad_scheme");
  // NOTE: ssl_error is deliberately NOT a reject reason — TLS != dead.

  const langs = splitCsv(rb.languagecodes).length
    ? splitCsv(rb.languagecodes)
    : splitCsv(rb.language);

  const entry = {
    name: String(rb.name || "").trim(),
    url,
    country: String(rb.countrycode || "").trim().toLowerCase(),
    genre: splitCsv(rb.tags).map((t) => t.toLowerCase()),
    lang: langs.map((l) => l.toLowerCase()),
    city: String(rb.state || "").trim(),
  };
  if (!entry.name) reasons.push("no_name");
  if (!entry.country) reasons.push("no_country");

  return reasons.length ? { ok: false, reason: reasons.join(","), entry } : { ok: true, entry };
}
