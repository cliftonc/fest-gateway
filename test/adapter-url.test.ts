/**
 * Upstream URL joining.
 *
 * This exists because `new URL(path, base)` silently drops the base's path when
 * the path is absolute — and every mock upstream in the test suite runs at
 * `http://127.0.0.1:PORT` with no path prefix, so nothing here caught it. The
 * real Fireworks endpoint is `https://api.fireworks.ai/inference`, and the bug
 * surfaced as `Path not found: /v1/messages` the first time a live key was
 * used.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { joinUpstreamUrl } from "../server/adapters/url.ts";

test("a base URL with a path prefix keeps that prefix", () => {
  assert.equal(
    joinUpstreamUrl("https://api.fireworks.ai/inference", "/v1/messages").toString(),
    "https://api.fireworks.ai/inference/v1/messages",
  );
});

test("the regression it was written for: URL() would have dropped /inference", () => {
  // Kept as an explicit contrast so the next person does not "simplify" this
  // back into URL resolution.
  const wrong = new URL("/v1/messages", "https://api.fireworks.ai/inference/").toString();
  assert.equal(wrong, "https://api.fireworks.ai/v1/messages");
  assert.notEqual(joinUpstreamUrl("https://api.fireworks.ai/inference", "/v1/messages").toString(), wrong);
});

test("a base URL with no prefix still works", () => {
  assert.equal(
    joinUpstreamUrl("https://api.anthropic.com", "/v1/messages").toString(),
    "https://api.anthropic.com/v1/messages",
  );
});

test("the query string survives — Claude Code calls /v1/messages?beta=true", () => {
  assert.equal(
    joinUpstreamUrl("https://api.fireworks.ai/inference", "/v1/messages?beta=true").toString(),
    "https://api.fireworks.ai/inference/v1/messages?beta=true",
  );
});

test("trailing and missing slashes are normalised to one seam", () => {
  for (const base of [
    "https://x.test/inference",
    "https://x.test/inference/",
    "https://x.test/inference///",
  ]) {
    assert.equal(joinUpstreamUrl(base, "/v1/messages").toString(), "https://x.test/inference/v1/messages", base);
  }
  assert.equal(
    joinUpstreamUrl("https://x.test/inference", "v1/messages").toString(),
    "https://x.test/inference/v1/messages",
  );
});

test("a deep prefix is preserved whole", () => {
  assert.equal(
    joinUpstreamUrl("https://gw.corp/ai/v2/anthropic", "/v1/messages").toString(),
    "https://gw.corp/ai/v2/anthropic/v1/messages",
  );
});
