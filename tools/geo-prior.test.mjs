import { test } from "node:test";
import assert from "node:assert/strict";
import { geoPriorForUrl, selectGeoCandidates } from "./geo-prior.mjs";

test("radiko.jp → jp + radiko type", () => {
  assert.deepEqual(geoPriorForUrl("https://radiko.jp/v2/api/ts/playlist.m3u8?station_id=TBS"),
    { country: "jp", type: "radiko" });
});
test("ordinary broadcaster → null (no false geo-lock)", () => {
  assert.equal(geoPriorForUrl("https://liveradio.swr.de/sw282p3/swr3/play.mp3"), null);
  assert.equal(geoPriorForUrl("https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3"), null);
});
test("garbage url → null", () => {
  assert.equal(geoPriorForUrl("not a url"), null);
});
test("geoHint record is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "X", url: "https://x", reachability: "unknown", geoHint: true }]).length, 1);
});
test("plain reachable global is NOT a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "Pop FM", url: "https://pop.example/s.mp3", reachability: "reachable", geoHint: false }]).length, 0);
});
test("radiko prior is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "TBS", url: "https://radiko.jp/x", reachability: "reachable", geoHint: false }]).length, 1);
});
test("event keyword is a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "Bundesliga Konferenz", url: "https://x", reachability: "reachable", geoHint: false }]).length, 1);
});
test("dead is never a candidate", () => {
  assert.equal(selectGeoCandidates([{ name: "X", url: "https://radiko.jp/x", reachability: "dead", geoHint: true }]).length, 0);
});
