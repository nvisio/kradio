import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyReachability, isPrunable } from "./probe-classify.mjs";

test("DNS NXDOMAIN → dead", () => {
  assert.deepEqual(classifyReachability({ errorCode: "ENOTFOUND" }),
    { reachability: "dead", geoHint: false, signal: "ENOTFOUND" });
});
test("connection refused → dead", () => {
  assert.equal(classifyReachability({ errorCode: "ECONNREFUSED" }).reachability, "dead");
});
test("TLS cert error → dead", () => {
  assert.equal(classifyReachability({ errorCode: "DEPTH_ZERO_SELF_SIGNED_CERT" }).reachability, "dead");
});
test("timeout → unknown (not dead)", () => {
  assert.equal(classifyReachability({ errorCode: "ETIMEDOUT" }).reachability, "unknown");
});
test("connection reset → unknown", () => {
  assert.equal(classifyReachability({ errorCode: "ECONNRESET" }).reachability, "unknown");
});
test("404 → dead", () => {
  assert.equal(classifyReachability({ status: 404 }).reachability, "dead");
});
test("410 → dead", () => {
  assert.equal(classifyReachability({ status: 410 }).reachability, "dead");
});
test("403 → unknown + geoHint", () => {
  const r = classifyReachability({ status: 403 });
  assert.equal(r.reachability, "unknown");
  assert.equal(r.geoHint, true);
});
test("451 → unknown + geoHint", () => {
  assert.equal(classifyReachability({ status: 451 }).geoHint, true);
});
test("200 audio/mpeg → reachable", () => {
  assert.equal(classifyReachability({ status: 200, contentType: "audio/mpeg" }).reachability, "reachable");
});
test("206 HLS playlist → reachable", () => {
  assert.equal(classifyReachability({ status: 206, contentType: "application/vnd.apple.mpegurl" }).reachability, "reachable");
});
test("200 text/html → unknown (bad content type)", () => {
  assert.equal(classifyReachability({ status: 200, contentType: "text/html" }).reachability, "unknown");
});
test("503 → unknown (kept, transient)", () => {
  assert.equal(classifyReachability({ status: 503 }).reachability, "unknown");
});
test("isPrunable: dead → true; unknown/reachable → false", () => {
  assert.equal(isPrunable({ reachability: "dead" }), true);
  assert.equal(isPrunable({ reachability: "unknown" }), false);
  assert.equal(isPrunable({ reachability: "reachable" }), false);
});
