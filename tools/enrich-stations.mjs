#!/usr/bin/env node
// tools/enrich-stations.mjs
//
// Heuristically fill in `genre` and `lang` for entries in a stations.json
// dataset (e.g. a Radio Garden export) where those arrays are empty.
//
// Usage:
//   node tools/enrich-stations.mjs <input.json>             → writes <input>.enriched.json
//   node tools/enrich-stations.mjs <input.json> --in-place  → overwrites <input.json>
//   node tools/enrich-stations.mjs <input.json> --out file.json
//   node tools/enrich-stations.mjs <input.json> --dry-run   → only print summary
//
// Heuristics (intentionally conservative — leave empty if no signal):
//   genre: keyword regex against the station name
//   lang : country → primary language(s), plus non-Latin script overrides
//          from the name (Hangul → ko, kana → ja, Arabic → ar, …)

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ── arg parsing ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { input: null, output: null, inPlace: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--in-place": o.inPlace = true; break;
      case "--dry-run":  o.dryRun = true; break;
      case "--out":      o.output = argv[++i]; break;
      case "-h":
      case "--help":     o.help = true; break;
      default:           if (!o.input) o.input = a;
    }
  }
  return o;
}

function printHelp() {
  console.log(`Usage: node tools/enrich-stations.mjs <input.json> [opts]

Options:
  --in-place        overwrite the input file
  --out <path>      write to a specific path (otherwise <input>.enriched.json)
  --dry-run         compute but don't write
  -h, --help        show this message`);
}

// ── ISO 3166 alpha-2 → primary ISO 639-1 languages (lowercase) ─────────
// Covers all UN-recognized countries plus a few dependencies. Order =
// importance (national/official > major regional).
const COUNTRY_LANGS = {
  ad: ["ca"], ae: ["ar"], af: ["fa","ps"], ag: ["en"], ai: ["en"],
  al: ["sq"], am: ["hy"], ao: ["pt"], aq: ["en"], ar: ["es"],
  as: ["en","sm"], at: ["de"], au: ["en"], aw: ["nl"], ax: ["sv"],
  az: ["az"],
  ba: ["bs","hr","sr"], bb: ["en"], bd: ["bn"], be: ["nl","fr","de"],
  bf: ["fr"], bg: ["bg"], bh: ["ar"], bi: ["rn","fr","en"], bj: ["fr"],
  bl: ["fr"], bm: ["en"], bn: ["ms"], bo: ["es"], bq: ["nl"], br: ["pt"],
  bs: ["en"], bt: ["dz"], bw: ["en","tn"], by: ["be","ru"], bz: ["en"],
  ca: ["en","fr"], cc: ["en"], cd: ["fr"], cf: ["fr"], cg: ["fr"],
  ch: ["de","fr","it"], ci: ["fr"], ck: ["en"], cl: ["es"], cm: ["fr","en"],
  cn: ["zh"], co: ["es"], cr: ["es"], cu: ["es"], cv: ["pt"], cw: ["nl"],
  cx: ["en"], cy: ["el","tr"], cz: ["cs"],
  de: ["de"], dj: ["fr","ar"], dk: ["da"], dm: ["en"], do: ["es"],
  dz: ["ar","fr"],
  ec: ["es"], ee: ["et"], eg: ["ar"], eh: ["ar"], er: ["ti","ar","en"],
  es: ["es"], et: ["am"],
  fi: ["fi","sv"], fj: ["en"], fk: ["en"], fm: ["en"], fo: ["fo","da"],
  fr: ["fr"],
  ga: ["fr"], gb: ["en"], gd: ["en"], ge: ["ka"], gf: ["fr"], gg: ["en"],
  gh: ["en"], gi: ["en"], gl: ["kl","da"], gm: ["en"], gn: ["fr"],
  gp: ["fr"], gq: ["es","fr","pt"], gr: ["el"], gt: ["es"], gu: ["en"],
  gw: ["pt"], gy: ["en"],
  hk: ["zh","en"], hn: ["es"], hr: ["hr"], ht: ["fr","ht"], hu: ["hu"],
  id: ["id"], ie: ["en","ga"], il: ["he"], im: ["en"], in: ["hi","en"],
  io: ["en"], iq: ["ar"], ir: ["fa"], is: ["is"], it: ["it"],
  je: ["en"], jm: ["en"], jo: ["ar"], jp: ["ja"],
  ke: ["sw","en"], kg: ["ky","ru"], kh: ["km"], ki: ["en"], km: ["ar","fr"],
  kn: ["en"], kp: ["ko"], kr: ["ko"], kw: ["ar"], ky: ["en"], kz: ["kk","ru"],
  la: ["lo"], lb: ["ar"], lc: ["en"], li: ["de"], lk: ["si","ta"],
  lr: ["en"], ls: ["en","st"], lt: ["lt"], lu: ["fr","de","lb"], lv: ["lv"],
  ly: ["ar"],
  ma: ["ar","fr"], mc: ["fr"], md: ["ro"], me: ["sr"], mf: ["fr"],
  mg: ["mg","fr"], mh: ["en"], mk: ["mk"], ml: ["fr"], mm: ["my"],
  mn: ["mn"], mo: ["zh","pt"], mp: ["en"], mq: ["fr"], mr: ["ar"],
  ms: ["en"], mt: ["mt","en"], mu: ["en","fr"], mv: ["dv"], mw: ["en"],
  mx: ["es"], my: ["ms","en"], mz: ["pt"],
  na: ["en"], nc: ["fr"], ne: ["fr"], nf: ["en"], ng: ["en"], ni: ["es"],
  nl: ["nl"], no: ["no"], np: ["ne"], nr: ["en","na"], nu: ["en"], nz: ["en"],
  om: ["ar"],
  pa: ["es"], pe: ["es"], pf: ["fr"], pg: ["en"], ph: ["en","tl"],
  pk: ["ur","en"], pl: ["pl"], pm: ["fr"], pn: ["en"], pr: ["es","en"],
  ps: ["ar"], pt: ["pt"], pw: ["en"], py: ["es","gn"],
  qa: ["ar"],
  re: ["fr"], ro: ["ro"], rs: ["sr"], ru: ["ru"], rw: ["rw","en","fr"],
  sa: ["ar"], sb: ["en"], sc: ["en","fr"], sd: ["ar","en"], se: ["sv"],
  sg: ["en","zh","ms","ta"], sh: ["en"], si: ["sl"], sk: ["sk"], sl: ["en"],
  sm: ["it"], sn: ["fr"], so: ["so","ar"], sr: ["nl"], ss: ["en"],
  st: ["pt"], sv: ["es"], sx: ["nl","en"], sy: ["ar"], sz: ["en"],
  tc: ["en"], td: ["fr","ar"], tg: ["fr"], th: ["th"], tj: ["tg"],
  tk: ["en"], tl: ["pt"], tm: ["tk"], tn: ["ar","fr"], to: ["en"],
  tr: ["tr"], tt: ["en"], tv: ["en"], tw: ["zh"], tz: ["sw","en"],
  ua: ["uk"], ug: ["en","sw"], us: ["en"], uy: ["es"], uz: ["uz"],
  va: ["it"], vc: ["en"], ve: ["es"], vg: ["en"], vi: ["en"],
  vn: ["vi"], vu: ["bi","en","fr"],
  wf: ["fr"], ws: ["sm","en"],
  xk: ["sq","sr"],
  ye: ["ar"], yt: ["fr"],
  za: ["en","zu","xh","af"], zm: ["en"], zw: ["en"]
};

// ── Genre keyword regex → tags. Multi-match; order doesn't matter. ─────
const GENRE_PATTERNS = [
  // Specific music genres
  [/\bjazz\b/i,                                           ["jazz"]],
  [/\bblues\b/i,                                          ["blues"]],
  [/\bclass(ic|ical|ique|ica|iek|ico)\b/i,                ["classical"]],
  [/\b(klassik|klasyczna|klassiek|klassieke)\b/i,         ["classical"]],

  [/\b(rock|punk|grunge|psychedelic)\b/i,                 ["rock"]],
  [/\bmetal\b/i,                                          ["metal","rock"]],
  [/\b(indie|alt(ernative)?)\b/i,                         ["alternative"]],

  [/\b(k[\s\-_]?pop)\b/i,                                 ["kpop","pop"]],
  [/\b(j[\s\-_]?pop|j[\s\-_]?rock|j[\s\-_]?wave|j[\s\-_]?hits)\b/i, ["jpop","pop"]],
  [/\b(c[\s\-_]?pop|mandopop|cantopop)\b/i,               ["cpop","pop"]],
  [/\bpop\b/i,                                            ["pop"]],

  [/\b(country|western|bluegrass)\b/i,                    ["country"]],
  [/\b(folk|tradition(al|nelle)?|tradicional)\b/i,        ["folk"]],
  [/\b(oldies|retro|nostalg(ia|ic)|vintage)\b/i,          ["oldies"]],
  [/\b(60s|70s|80s|90s|60er|70er|80er|90er|sixties|seventies|eighties|nineties)\b/i, ["oldies"]],

  [/\b(edm|electro(nic|nica)?|techno|trance|house|club|rave|dnb|drum.?n.?bass|electronica)\b/i, ["electronic"]],
  [/\b(dance|disco)\b/i,                                  ["dance"]],
  [/\b(ambient|chill(out)?|lounge|relax|spa)\b/i,         ["chill","ambient"]],

  [/\b(hip[\s\-]?hop|hiphop|rap|urban|trap)\b/i,          ["hiphop"]],
  [/\b(r[\s\-]?n?[\s\-]?b|rnb|soul|motown|funk)\b/i,      ["rnb"]],
  [/\b(reggae|dub|dancehall|ska)\b/i,                     ["reggae"]],

  // Cultural / regional
  [/\b(latin(o|a)?|salsa|reggaeton|bachata|merengue|cumbia|mariachi|ranchera|cori?do|corrido|tango|banda)\b/i, ["latin"]],
  [/\b(samba|bossa|forro|forr[óo])\b/i,                   ["latin"]],
  [/\b(afro|amapiano|highlife|kompa|kwaito|gqom)\b/i,     ["afro"]],
  [/\b(arab(ic|e|ica)?|tarab|nas[hh]eed|عربي)\b/i,        ["arabic"]],
  [/\b(bollywood|hindi|filmi|desi)\b/i,                   ["bollywood","pop"]],
  [/\b(chanson|francophone|francais|fran[çc]ais)\b/i,     ["chanson"]],
  [/\b(schlager|volksmusik)\b/i,                          ["schlager"]],
  [/\b(turku|t[üu]rk[çc]e)\b/i,                           ["turkish"]],

  // Religious
  [/\b(christ(ian)?|gospel|catholic|cat[óo]li(co|ca|que)|catholique|fatima|kingdom|church|igreja|kirche)\b/i, ["christian"]],
  [/\b(islam(ic|ique|ica)?|qu?r['']?an|coran|cor[ãa]o|ramadan|nasheed)\b/i, ["islamic"]],
  [/\bbuddh(ist|a|ism)\b/i,                               ["buddhist"]],
  [/(불교|佛教)/,                                          ["buddhist"]],
  [/\bhindu\b/i,                                          ["hindu"]],
  [/\b(jewish|hebrew|kosher)\b/i,                         ["jewish"]],

  // Format / talk-ish
  [/\b(news|nachrichten|noticias|noticia|notizie|nouvelles|info|aktuell|haber)\b/i, ["news"]],
  [/(뉴스|新聞|新闻)/,                                      ["news"]],
  [/\b(talk|discussion|debate|interview|talkradio|conversation|tertulia|gespr[äa]ch|d[ée]bat)\b/i, ["talk"]],
  [/\b(sport|sports|deportes|sportradio|fussball|football)\b/i, ["sport"]],
  [/(스포츠|スポーツ)/,                                     ["sport"]],
  [/\b(comedy|humor|h[uú]mor|comed(ia|y))\b/i,            ["comedy"]],
  [/\b(kids|children|ni[ñn]os|enfants|kinder|bambin[ai])\b/i, ["kids"]],
  [/\b(community|comunidad|comunidade|communaut[ée])\b/i, ["community"]],
  [/\b(college|campus|university|universidad|universidade|universit[ée]|hochschul)\b/i, ["college"]],
  [/\b(anime|アニメ|cosplay)\b/i,                          ["anime"]],
  [/\b(retro|classics|hits)\b/i,                          ["hits"]],

  // Decades — also tagged separately
  [/\b80s\b/i,                                            ["80s"]],
  [/\b70s\b/i,                                            ["70s"]],
  [/\b90s\b/i,                                            ["90s"]],
  [/\b60s\b/i,                                            ["60s"]],
  [/\b2000s\b/i,                                          ["2000s"]],

  // Network/brand → format guesses (helpful for ~big public broadcasters)
  [/\bbbc world\b/i,                                      ["news","talk"]],
  [/\bbbc radio 3\b/i,                                    ["classical"]],
  [/\bbbc radio 4\b/i,                                    ["news","talk"]],
  [/\bbbc radio 6\b/i,                                    ["alternative"]],
  [/\bnpr\b/i,                                            ["news","talk"]],
];

// Non-Latin script → likely language. Ordered most-specific first.
const SCRIPT_LANG = [
  [/[぀-ゟ゠-ヿ]/, "ja"], // Hiragana + Katakana (Japanese)
  [/[가-힯]/,              "ko"], // Hangul
  [/[฀-๿]/,              "th"], // Thai
  [/[ऀ-ॿ]/,              "hi"], // Devanagari (Hindi)
  [/[ঀ-৿]/,              "bn"], // Bengali
  [/[਀-੿]/,              "pa"], // Gurmukhi
  [/[઀-૿]/,              "gu"], // Gujarati
  [/[଀-୿]/,              "or"], // Oriya
  [/[஀-௿]/,              "ta"], // Tamil
  [/[ఀ-౿]/,              "te"], // Telugu
  [/[ಀ-೿]/,              "kn"], // Kannada
  [/[ഀ-ൿ]/,              "ml"], // Malayalam
  [/[֐-׿]/,              "he"], // Hebrew
  [/[؀-ۿݐ-ݿ]/, "ar"], // Arabic
  [/[Ѐ-ӿ]/,              "ru"], // Cyrillic (default to Russian; country wins if e.g. ua/bg)
  [/[㐀-鿿]/,              "zh"], // CJK ideographs — could be ja or zh; resolve via country
];

// ── inference ──────────────────────────────────────────────────────────
function inferGenre(name) {
  if (!name) return [];
  const tags = [];
  for (const [re, tagList] of GENRE_PATTERNS) {
    if (re.test(name)) {
      for (const t of tagList) if (!tags.includes(t)) tags.push(t);
    }
  }
  // Cap at 4 tags; keep first matches (specificity-ordered above).
  return tags.slice(0, 4);
}

function inferLang(name, country) {
  const cc = (country || "").toLowerCase();
  const fromCountry = COUNTRY_LANGS[cc] || [];

  // Script overrides
  const overrides = [];
  for (const [re, lang] of SCRIPT_LANG) {
    if (!re.test(name)) continue;
    // CJK ideographs without kana → assume the country's primary
    if (lang === "zh" && cc === "jp") continue;
    if (lang === "zh" && cc === "kr") continue;
    if (lang === "zh" && cc === "tw") continue;
    if (lang === "zh" && cc === "hk") continue;
    // Cyrillic — if country already uses Cyrillic, country wins (skip ru override)
    if (lang === "ru" && ["bg","ua","rs","mk","by","kz","kg","tj","mn"].includes(cc)) continue;
    overrides.push(lang);
  }

  const seen = new Set();
  const out = [];
  for (const l of overrides.concat(fromCountry)) {
    if (!seen.has(l)) { seen.add(l); out.push(l); }
  }
  return out;
}

function enrichEntry(s) {
  const beforeG = (s.genre || []).length;
  const beforeL = (s.lang || []).length;
  if (!Array.isArray(s.genre)) s.genre = [];
  if (!Array.isArray(s.lang))  s.lang  = [];
  if (s.genre.length === 0) {
    const g = inferGenre(s.name || "");
    if (g.length) s.genre = g;
  }
  if (s.lang.length === 0) {
    const l = inferLang(s.name || "", s.country || "");
    if (l.length) s.lang = l;
  }
  return {
    changedG: s.genre.length > beforeG,
    changedL: s.lang.length > beforeL,
  };
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const inputPath = resolve(args.input);
  const data = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(data)) throw new Error("input must be a JSON array");

  let gFilled = 0, lFilled = 0;
  const genreTally = new Map();
  const langTally = new Map();

  for (const s of data) {
    const { changedG, changedL } = enrichEntry(s);
    if (changedG) gFilled++;
    if (changedL) lFilled++;
    for (const g of (s.genre || [])) genreTally.set(g, (genreTally.get(g) || 0) + 1);
    for (const l of (s.lang  || [])) langTally.set(l,  (langTally.get(l)  || 0) + 1);
  }

  console.log(`Total stations: ${data.length}`);
  console.log(`  genre filled:  ${gFilled}  (${(gFilled/data.length*100).toFixed(1)}%)`);
  console.log(`  lang  filled:  ${lFilled}  (${(lFilled/data.length*100).toFixed(1)}%)`);

  console.log("\nTop genres:");
  for (const [g, n] of [...genreTally.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25)) {
    console.log(`  ${g.padEnd(12)} ${n}`);
  }
  console.log("\nTop langs:");
  for (const [l, n] of [...langTally.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25)) {
    console.log(`  ${l.padEnd(6)} ${n}`);
  }

  if (args.dryRun) {
    console.log("\n--dry-run: not writing");
    return;
  }
  const outputPath = args.inPlace
    ? inputPath
    : (args.output || (inputPath.replace(/\.json$/i, "") + ".enriched.json"));
  await writeFile(outputPath, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nwrote ${outputPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
