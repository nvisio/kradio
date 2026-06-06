// tools/lib/radio-garden.mjs
// Shared radio.garden helpers (network + pure). The pure parts are unit-tested.

export const RG = "https://radio.garden";
export const UA = "kradio-importer/1.0 (+https://kradio.nvis.io)";

// ── pure: country name → ISO 3166-1 alpha-2 (lowercase) ────────────────
// Built by inverting Intl.DisplayNames over all alpha-2 codes (covers ~200
// countries), plus a small alias table for the names radio.garden uses that
// don't match Intl's canonical display name.
const ALIASES = {
  "usa": "us", "u.s.a.": "us", "u.s.": "us", "america": "us",
  "uk": "gb", "u.k.": "gb", "england": "gb", "great britain": "gb",
  "russia": "ru", "south korea": "kr", "north korea": "kp",
  "vietnam": "vn", "laos": "la", "syria": "sy", "iran": "ir",
  "moldova": "md", "bolivia": "bo", "venezuela": "ve", "tanzania": "tz",
  "czech republic": "cz", "czechia": "cz",
};

// Canonical ISO 3166-1 alpha-2 (currently assigned). Inverting ONLY these via
// Intl avoids historic/reserved codes (DD=East Germany, UK, SU, YU…) that share
// a display name with a current code and would otherwise win.
const ISO_ALPHA2 = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL " +
  "BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV " +
  "CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD " +
  "GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM " +
  "IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK " +
  "LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW " +
  "MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR " +
  "PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS " +
  "ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY " +
  "UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");

const NAME_TO_CODE = (() => {
  const map = new Map();
  let dn;
  try { dn = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }); } catch { dn = null; }
  if (dn) {
    for (const code of ISO_ALPHA2) {
      let name;
      try { name = dn.of(code); } catch { name = null; }
      if (name && name !== code) map.set(name.toLowerCase(), code.toLowerCase());
    }
  }
  for (const [k, v] of Object.entries(ALIASES)) map.set(k, v);
  return map;
})();

export function countryCodeFrom(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  if (NAME_TO_CODE.has(k)) return NAME_TO_CODE.get(k);
  if (/^[a-z]{2}$/.test(k)) return k;
  return null;
}

// ── pure: dedup key + membership ───────────────────────────────────────
export function nameKey(name, country) {
  const n = String(name || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")   // strip punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
  const c = String(country || "").toLowerCase().trim();
  return `${n}|${c}`;
}

export function isKnown(name, country, knownSet) {
  return knownSet.has(nameKey(name, country));
}
