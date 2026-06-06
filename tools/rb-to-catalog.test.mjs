import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStation, normUrl } from "./rb-to-catalog.mjs";

function rb(over = {}) {
  return {
    name: "Jazz FM", url: "https://x/play.pls",
    url_resolved: "https://stream.example/jazz.mp3",
    countrycode: "GB", tags: "jazz,smooth jazz",
    languagecodes: "en", language: "english",
    state: "London", codec: "MP3", bitrate: 128,
    lastcheckok: 1, ssl_error: 0, ...over,
  };
}

test("maps a clean station", () => {
  const r = mapStation(rb());
  assert.equal(r.ok, true);
  assert.deepEqual(r.entry, {
    name: "Jazz FM",
    url: "https://stream.example/jazz.mp3",
    country: "gb",
    genre: ["jazz", "smooth jazz"],
    lang: ["en"],
    city: "London",
  });
});
test("prefers url_resolved; falls back to url when empty", () => {
  assert.equal(mapStation(rb({ url_resolved: "" })).entry.url, "https://x/play.pls");
});
test("lowercases country code", () => {
  assert.equal(mapStation(rb({ countrycode: "KR" })).entry.country, "kr");
});
test("splits comma tags + trims, drops empties", () => {
  assert.deepEqual(mapStation(rb({ tags: " rock , , pop " })).entry.genre, ["rock", "pop"]);
});
test("languagecodes preferred over language; lowercased", () => {
  assert.deepEqual(mapStation(rb({ languagecodes: "DE,EN", language: "german" })).entry.lang, ["de", "en"]);
});
test("falls back to language when languagecodes empty", () => {
  assert.deepEqual(mapStation(rb({ languagecodes: "", language: "Korean" })).entry.lang, ["korean"]);
});
test("rejects lastcheckok=0", () => {
  assert.equal(mapStation(rb({ lastcheckok: 0 })).ok, false);
});
test("rejects bitrate 0", () => {
  assert.equal(mapStation(rb({ bitrate: 0 })).ok, false);
});
test("rejects empty codec", () => {
  assert.equal(mapStation(rb({ codec: "" })).ok, false);
});
test("rejects non-http url", () => {
  assert.equal(mapStation(rb({ url_resolved: "rtmp://x/y" })).ok, false);
});
test("rejects empty url (both fields)", () => {
  assert.equal(mapStation(rb({ url_resolved: "", url: "" })).ok, false);
});
test("does NOT reject on ssl_error=1 (TLS != dead)", () => {
  assert.equal(mapStation(rb({ ssl_error: 1 })).ok, true);
});
test("normUrl lowercases, trims, strips trailing slash", () => {
  assert.equal(normUrl("  HTTPS://A.Com/Stream/ "), "https://a.com/stream");
});
