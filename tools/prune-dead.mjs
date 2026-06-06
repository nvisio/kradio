#!/usr/bin/env node
// tools/prune-dead.mjs
// OCCASIONAL manual compaction: physically remove hard-dead entries from
// stations.json, keyed by URL, using a probe report. Only reachability ===
// "dead" (DNS/conn/TLS/404/410) is removed; timeouts, 403, 5xx are kept.
// Refuses on a suspiciously small report. NOT run on a schedule.
//
//   node tools/prune-dead.mjs [--report tools/probe-report.full.json] [--stations stations.json] [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrunable } from "./probe-classify.mjs";

const MIN_REPORT = 1000;

function parseArgs(argv) {
  const o = { report: "tools/probe-report.full.json", stations: "stations.json", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") o.report = argv[++i];
    else if (argv[i] === "--stations") o.stations = argv[++i];
    else if (argv[i] === "--dry-run") o.dryRun = true;
  }
  return o;
}

function compactArrayJSON(arr) {
  if (arr.length === 0) return "[]\n";
  return "[\n  " + arr.map((o) => JSON.stringify(o)).join(",\n  ") + "\n]\n";
}

const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const report = JSON.parse(await readFile(resolve(a.report), "utf8"));
  if (!Array.isArray(report) || report.length < MIN_REPORT) {
    throw new Error(`report ${a.report} has ${report.length} rows (< ${MIN_REPORT}); refusing to prune`);
  }
  const deadUrls = new Set(report.filter(isPrunable).map((r) => normUrl(r.url)).filter(Boolean));
  const stations = JSON.parse(await readFile(resolve(a.stations), "utf8"));
  const kept = stations.filter((s) => !deadUrls.has(normUrl(s.url)));
  console.error(`report ${report.length}  hard-dead ${deadUrls.size}  stations ${stations.length} → ${kept.length} (pruned ${stations.length - kept.length})`);
  if (a.dryRun) { console.error("dry-run: not writing"); return; }
  await writeFile(resolve(a.stations), compactArrayJSON(kept), "utf8");
  console.error(`wrote ${a.stations}\nnext: node tools/build-index.mjs`);
}

main().catch((e) => { console.error(e); process.exit(1); });
