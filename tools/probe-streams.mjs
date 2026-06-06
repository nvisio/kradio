#!/usr/bin/env node
// tools/probe-streams.mjs
// Deterministic, LLM-free stream reachability probe. Writes a sidecar report;
// never touches featured/ or stations.json.
//
//   node tools/probe-streams.mjs --featured                    → tools/probe-report.featured.json
//   node tools/probe-streams.mjs stations.json                 → tools/probe-report.full.json
//   node tools/probe-streams.mjs <input> --out f --concurrency 40 --timeout 8000

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { classifyReachability } from "./probe-classify.mjs";

function parseArgs(argv) {
  const o = { input: null, featured: false, out: null, concurrency: 20, timeout: 8000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--featured") o.featured = true;
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--concurrency") o.concurrency = parseInt(argv[++i], 10);
    else if (a === "--timeout") o.timeout = parseInt(argv[++i], 10);
    else if (!o.input) o.input = a;
  }
  return o;
}

async function loadFeatured() {
  const dir = resolve("featured");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const out = [];
  for (const f of files) {
    const cc = f.replace(/\.json$/i, "").toLowerCase();
    const arr = JSON.parse(await readFile(join(dir, f), "utf8"));
    for (const e of arr) out.push({ name: e.name, url: e.url, country: cc });
  }
  return out;
}

async function loadCatalog(path) {
  const arr = JSON.parse(await readFile(resolve(path), "utf8"));
  return arr.map((e) => ({ name: e.name, url: e.url, country: (e.country || "").toLowerCase() }));
}

async function probeOnce(url, timeout) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-1", "User-Agent": "kradio-probe/1 (+https://kradio.nvis.io)" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    return { status: res.status, contentType: res.headers.get("content-type") };
  } finally {
    clearTimeout(t);
  }
}

async function probeOne(entry, timeout) {
  const base = { name: entry.name, url: entry.url, country: entry.country, checkedAt: new Date().toISOString() };
  if (!entry.url) {
    return { ...base, httpStatus: null, contentType: null, reachability: "unknown", geoHint: false, signal: "no_url" };
  }
  try {
    let r = await probeOnce(entry.url, timeout);
    if (r.status >= 500) {
      try { r = await probeOnce(entry.url, timeout); } catch { /* keep first */ }
    }
    const c = classifyReachability({ status: r.status, contentType: r.contentType });
    return { ...base, httpStatus: r.status, contentType: r.contentType, ...c };
  } catch (e) {
    const code = e?.cause?.code || (e?.name === "AbortError" ? "ETIMEDOUT" : e?.code) || "ERR";
    const c = classifyReachability({ errorCode: code });
    return { ...base, httpStatus: null, contentType: null, error: String(e?.message || e), ...c };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
      if (++done % 200 === 0) process.stderr.write(`  probed ${done}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const items = args.featured ? await loadFeatured() : await loadCatalog(args.input);
  const out = args.out || (args.featured ? "tools/probe-report.featured.json" : "tools/probe-report.full.json");
  console.error(`probing ${items.length} streams (concurrency ${args.concurrency}, timeout ${args.timeout}ms)…`);
  const records = await pool(items, args.concurrency, (e) => probeOne(e, args.timeout));
  await writeFile(resolve(out), JSON.stringify(records) + "\n", "utf8");
  const tally = records.reduce((m, r) => ((m[r.reachability] = (m[r.reachability] || 0) + 1), m), {});
  console.error(`wrote ${out} — ${JSON.stringify(tally)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
