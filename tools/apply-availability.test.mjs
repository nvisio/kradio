import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeVerdict } from "./apply-availability.mjs";

test("global verdict → minimal {name,url}", () => {
  const e = { name: "X", url: "https://x", availability: "geo_restricted", countries: ["de"] };
  assert.deepEqual(mergeVerdict(e, { availability: "global" }), { name: "X", url: "https://x" });
});
test("no verdict → minimal {name,url}", () => {
  assert.deepEqual(mergeVerdict({ name: "X", url: "https://x" }, null), { name: "X", url: "https://x" });
});
test("geo_restricted → adds availability + lowercased countries", () => {
  const out = mergeVerdict({ name: "X", url: "https://x" }, { availability: "geo_restricted", countries: ["DE", "AT"] });
  assert.deepEqual(out, { name: "X", url: "https://x", availability: "geo_restricted", countries: ["de", "at"] });
});
test("event_based → adds availability", () => {
  assert.equal(mergeVerdict({ name: "Liga", url: "https://x" }, { availability: "event_based", countries: ["de"] }).availability, "event_based");
});
test("radiko verdict → adds type + stationId, keeps url fallback", () => {
  const out = mergeVerdict({ name: "TBS", url: "https://radiko.jp/x" },
    { availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS" });
  assert.deepEqual(out, { name: "TBS", url: "https://radiko.jp/x", availability: "geo_restricted", countries: ["jp"], type: "radiko", stationId: "TBS" });
});
test("dead verdict → marks availability dead", () => {
  assert.equal(mergeVerdict({ name: "X", url: "https://x" }, { availability: "dead" }).availability, "dead");
});
