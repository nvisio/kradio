import { test } from "node:test";
import assert from "node:assert/strict";
import { countryCodeFrom, nameKey, isKnown, changedPlaces, nextSigs } from "./radio-garden.mjs";

test("countryCodeFrom: common names via Intl", () => {
  assert.equal(countryCodeFrom("Germany"), "de");
  assert.equal(countryCodeFrom("South Korea"), "kr");
  assert.equal(countryCodeFrom("United States"), "us");
  assert.equal(countryCodeFrom("United Kingdom"), "gb");
});
test("countryCodeFrom: thin countries the old table missed", () => {
  assert.equal(countryCodeFrom("Bulgaria"), "bg");
  assert.equal(countryCodeFrom("Sri Lanka"), "lk");
  assert.equal(countryCodeFrom("Estonia"), "ee");
});
test("countryCodeFrom: alias fallback", () => {
  assert.equal(countryCodeFrom("USA"), "us");
  assert.equal(countryCodeFrom("UK"), "gb");
});
test("countryCodeFrom: already a 2-letter code", () => {
  assert.equal(countryCodeFrom("kr"), "kr");
});
test("countryCodeFrom: unknown → null", () => {
  assert.equal(countryCodeFrom("Atlantis"), null);
  assert.equal(countryCodeFrom(""), null);
  assert.equal(countryCodeFrom(null), null);
});
test("nameKey: normalizes name + country + city", () => {
  assert.equal(nameKey("  KBS  Cool FM ", "kr", "Seoul"), "kbs cool fm|kr|seoul");
  assert.equal(nameKey("KBS Cool FM", "KR", "seoul"), "kbs cool fm|kr|seoul");
});
test("nameKey: collapses internal whitespace + strips punctuation (name + city)", () => {
  assert.equal(nameKey("Jazz   FM!!", "gb", "London!"), "jazz fm|gb|london");
});
test("nameKey: empty city still keys", () => {
  assert.equal(nameKey("Radio X", "fr", ""), "radio x|fr|");
  assert.equal(nameKey("Radio X", "fr", null), "radio x|fr|");
});
test("nameKey: same name+country, different city → different key", () => {
  assert.notEqual(nameKey("Hot 95", "us", "Orlando"), nameKey("Hot 95", "us", "Miami"));
});
test("isKnown: membership against a Set (name+country+city)", () => {
  const set = new Set([nameKey("Radio X", "fr", "Paris")]);
  assert.equal(isKnown("Radio X", "fr", "Paris", set), true);
  assert.equal(isKnown("Radio X", "fr", "Lyon", set), false);
  assert.equal(isKnown("Radio Y", "fr", "Paris", set), false);
});

test("changedPlaces: new + size-changed are returned; unchanged skipped", () => {
  const places = [
    { id: "a", size: 5 },   // unchanged
    { id: "b", size: 9 },   // changed (was 7)
    { id: "c", size: 3 },   // new (not in store)
  ];
  const stored = { a: 5, b: 7, d: 2 };
  const out = changedPlaces(places, stored).map((p) => p.id).sort();
  assert.deepEqual(out, ["b", "c"]);
});
test("changedPlaces: empty store → all places", () => {
  const places = [{ id: "a", size: 1 }, { id: "b", size: 2 }];
  assert.equal(changedPlaces(places, {}).length, 2);
});
test("nextSigs: carries forward current places, updates scanned, prunes removed", () => {
  const stored = { a: 5, b: 7, gone: 1 };
  const current = [{ id: "a", size: 5 }, { id: "b", size: 9 }, { id: "c", size: 3 }];
  const scanned = [{ id: "b", size: 9 }, { id: "c", size: 3 }];
  const out = nextSigs(stored, scanned, current);
  // a carried forward (5), b/c updated to scanned size, gone pruned (not in current)
  assert.deepEqual(out, { a: 5, b: 9, c: 3 });
});
