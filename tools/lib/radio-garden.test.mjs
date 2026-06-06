import { test } from "node:test";
import assert from "node:assert/strict";
import { countryCodeFrom, nameKey, isKnown } from "./radio-garden.mjs";

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
test("nameKey: normalizes name + country", () => {
  assert.equal(nameKey("  KBS  Cool FM ", "kr"), "kbs cool fm|kr");
  assert.equal(nameKey("KBS Cool FM", "KR"), "kbs cool fm|kr");
});
test("nameKey: collapses internal whitespace + strips punctuation", () => {
  assert.equal(nameKey("Jazz   FM!!", "gb"), "jazz fm|gb");
});
test("nameKey: empty country still keys", () => {
  assert.equal(nameKey("Radio X", ""), "radio x|");
});
test("isKnown: membership against a Set", () => {
  const set = new Set([nameKey("Radio X", "fr")]);
  assert.equal(isKnown("Radio X", "fr", set), true);
  assert.equal(isKnown("Radio Y", "fr", set), false);
});
