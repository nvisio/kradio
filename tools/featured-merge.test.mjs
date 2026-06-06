import { test } from "node:test";
import assert from "node:assert/strict";
import { unionFeatured } from "./featured-merge.mjs";

test("appends new incoming after existing, dedup by url", () => {
  const existing = [{ name: "A", url: "https://a" }];
  const incoming = [{ name: "A2", url: "https://a" }, { name: "B", url: "https://b" }];
  assert.deepEqual(unionFeatured(existing, incoming, 10),
    [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }]);
});
test("preserves existing order and flags", () => {
  const existing = [{ name: "Geo", url: "https://g", availability: "geo_restricted", countries: ["ro"] }];
  const incoming = [{ name: "New", url: "https://n" }];
  const out = unionFeatured(existing, incoming, 10);
  assert.deepEqual(out[0], { name: "Geo", url: "https://g", availability: "geo_restricted", countries: ["ro"] });
  assert.equal(out[1].name, "New");
});
test("dedup is case/trailing-slash insensitive", () => {
  const existing = [{ name: "A", url: "https://a.com/s/" }];
  const incoming = [{ name: "A2", url: "HTTPS://A.COM/s" }];
  assert.equal(unionFeatured(existing, incoming, 10).length, 1);
});
test("caps growth but never truncates existing", () => {
  const existing = [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }];
  const incoming = [{ name: "C", url: "https://c" }, { name: "D", url: "https://d" }];
  assert.deepEqual(unionFeatured(existing, incoming, 3).map((e) => e.name), ["A", "B", "C"]);
});
test("existing already at/over cap → no append", () => {
  const existing = [{ name: "A", url: "https://a" }, { name: "B", url: "https://b" }];
  const incoming = [{ name: "C", url: "https://c" }];
  assert.deepEqual(unionFeatured(existing, incoming, 2).map((e) => e.name), ["A", "B"]);
});
test("incoming entries are reduced to {name,url}", () => {
  const out = unionFeatured([], [{ name: "X", url: "https://x", votes: 5, tags: "pop" }], 10);
  assert.deepEqual(out, [{ name: "X", url: "https://x" }]);
});
