#!/usr/bin/env node
// tools/drop-dead-candidates.mjs
// Drop candidate stations that a probe report marks hard-dead (reuses isPrunable).
//   node tools/drop-dead-candidates.mjs --candidates tools/rb-candidates.json \
//        --report tools/probe-report.candidates.json [--out tools/rb-candidates.json]

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrunable } from "./probe-classify.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : def;
}
const normUrl = (u) => (u || "").trim().toLowerCase();

async function main() {
  const candPath = arg("--candidates", "tools/rb-candidates.json");
  const reportPath = arg("--report", "tools/probe-report.candidates.json");
  const outPath = arg("--out", candPath);

  const candidates = JSON.parse(await readFile(resolve(candPath), "utf8"));
  const report = JSON.parse(await readFile(resolve(reportPath), "utf8"));
  const deadUrls = new Set(report.filter(isPrunable).map((r) => normUrl(r.url)));

  const kept = candidates.filter((c) => !deadUrls.has(normUrl(c.url)));
  await writeFile(resolve(outPath), JSON.stringify(kept) + "\n", "utf8");
  console.error(`candidates ${candidates.length} → ${kept.length} (dropped ${candidates.length - kept.length} hard-dead)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
