#!/usr/bin/env node
// tools/build-index.mjs
//
// Pre-build an inverted index from stations.json so that the deep-link
// examples page can filter ~tens-of-thousands of entries instantly
// without scanning the whole array on every keystroke.
//
// Index shape:
//   {
//     totalCount,
//     byCountry: { kr: [indices…], jp: [indices…], … },
//     byGenre:   { jazz: [indices…], … },
//     byLang:    { ko: [indices…], … },
//     counts: { country: {kr:N…}, genre: {jazz:N…}, lang: {ko:N…} }
//   }
//
// Indices are positions in stations.json's outer array. The page does
// intersection of id arrays to compute filter results in O(matches).
//
// Usage:
//   node tools/build-index.mjs [stations.json] [stations.index.json]

import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";

async function main() {
  const argv = process.argv.slice(2);
  const inputPath  = resolve(argv[0] || "stations.json");
  const outputPath = resolve(argv[1] || join(dirname(inputPath), "stations.index.json"));
  const data = JSON.parse(await readFile(inputPath, "utf8"));
  if (!Array.isArray(data)) throw new Error("input must be a JSON array");

  const byCountry = Object.create(null);
  const byGenre   = Object.create(null);
  const byLang    = Object.create(null);

  data.forEach((s, i) => {
    const cc = (s.country || "").toLowerCase();
    if (cc) (byCountry[cc] ||= []).push(i);
    for (const g of (s.genre || [])) {
      const k = String(g).toLowerCase();
      if (k) (byGenre[k] ||= []).push(i);
    }
    for (const l of (s.lang || [])) {
      const k = String(l).toLowerCase();
      if (k) (byLang[k] ||= []).push(i);
    }
  });

  const tally = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.length]));
  const index = {
    totalCount: data.length,
    byCountry, byGenre, byLang,
    counts: {
      country: tally(byCountry),
      genre:   tally(byGenre),
      lang:    tally(byLang),
    },
  };

  await writeFile(outputPath, JSON.stringify(index));
  console.log(`indexed ${data.length} stations → ${outputPath}`);
  console.log(`  countries: ${Object.keys(byCountry).length}`);
  console.log(`  genres:    ${Object.keys(byGenre).length}`);
  console.log(`  langs:     ${Object.keys(byLang).length}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
