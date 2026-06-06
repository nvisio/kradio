import { test } from "node:test";
import assert from "node:assert/strict";
import { toHealth } from "./build-health.mjs";

const recs = [
  { url: "https://ok1", reachability: "reachable", signal: "ok", httpStatus: 200 },
  { url: "https://ok2", reachability: "reachable", signal: "ok", httpStatus: 206 },
  { url: "https://dead1", reachability: "dead", signal: "ENOTFOUND", httpStatus: null },
  { url: "https://geo1", reachability: "unknown", signal: "http_403", httpStatus: 403, geoHint: true },
];

test("counts healthy/unknown/dead", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.deepEqual(h.counts, { healthy: 2, unknown: 1, dead: 1 });
  assert.equal(h.total, 4);
  assert.equal(h.vantage, "test");
});
test("unhealthy lists only non-healthy, with fields", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.equal(h.unhealthy.length, 2);
  const dead = h.unhealthy.find((u) => u.url === "https://dead1");
  assert.deepEqual(dead, { url: "https://dead1", status: "dead", signal: "ENOTFOUND", httpStatus: null });
});
test("geoHint preserved only when true", () => {
  const h = toHealth(recs, { vantage: "test" });
  const geo = h.unhealthy.find((u) => u.url === "https://geo1");
  assert.equal(geo.geoHint, true);
  const dead = h.unhealthy.find((u) => u.url === "https://dead1");
  assert.equal("geoHint" in dead, false);
});
test("healthy URLs are omitted from unhealthy", () => {
  const h = toHealth(recs, { vantage: "test" });
  assert.equal(h.unhealthy.some((u) => u.url.startsWith("https://ok")), false);
});
