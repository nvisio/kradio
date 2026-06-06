#!/usr/bin/env node
// tools/build-health.mjs
// Distil a probe report into health.json — a compact deny-list of non-healthy
// URLs (absent ⇒ healthy). Pure toHealth() is unit-tested; the harness adds the
// timestamp and refuses to write on a suspiciously small report.
//
//   node tools/build-health.mjs [--report tools/probe-report.full.json] [--out health.json]
//   HEALTH_VANTAGE=github-actions-us node tools/build-health.mjs

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function toHealth(records, { vantage = "local" } = {}) {
  const counts = { healthy: 0, unknown: 0, dead: 0 };
  const unhealthy = [];
  for (const r of records) {
    const status = r.reachability === "reachable" ? "healthy" : r.reachability;
    counts[status] = (counts[status] || 0) + 1;
    if (status !== "healthy") {
      const row = { url: r.url, status, signal: r.signal, httpStatus: r.httpStatus ?? null };
      if (r.geoHint) row.geoHint = true;
      unhealthy.push(row);
    }
  }
  return { vantage, total: records.length, counts, unhealthy };
}

const MIN_REPORT = 1000;

async function main() {
  const argv = process.argv.slice(2);
  let report = "tools/probe-report.full.json", out = "health.json";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report") report = argv[++i];
    else if (argv[i] === "--out") out = argv[++i];
  }
  const records = JSON.parse(await readFile(resolve(report), "utf8"));
  if (!Array.isArray(records) || records.length < MIN_REPORT) {
    throw new Error(`report ${report} has ${records.length} rows (< ${MIN_REPORT}); refusing to overwrite ${out}`);
  }
  const health = {
    generatedAt: new Date().toISOString(),
    ...toHealth(records, { vantage: process.env.HEALTH_VANTAGE || "local" }),
  };
  await writeFile(resolve(out), JSON.stringify(health) + "\n", "utf8");
  console.error(`wrote ${out} — ${JSON.stringify(health.counts)} (unhealthy rows: ${health.unhealthy.length})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
