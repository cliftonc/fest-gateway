/**
 * Header discipline. These assertions encode empirically verified upstream
 * behaviour: the subscription OAuth token is validated against the request
 * shape, so any "tidying" of the forwarded headers breaks auth silently. If one
 * of these fails, the fix is almost never to change the test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUpstreamHeaders,
  buildDownstreamHeaders,
  parseRateLimit,
} from "../server/http/headers.ts";

const OAUTH = "sk-ant-oat01-HEADERFIXTUREAAAA";

/**
 * `Headers` is only iterable under lib.dom.iterable, which this project does
 * not include, so snapshot it via `forEach` instead of spreading it.
 */
function headerEntries(headers: Headers): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  headers.forEach((value, name) => entries.push([name.toLowerCase(), value]));
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries;
}

/** The 15 values a real claude-cli 2.1.278 request sends, in order. */
const ANTHROPIC_BETA = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
  "context-1m-2025-08-07",
  "token-efficient-tools-2025-02-19",
  "prompt-caching-2024-07-31",
  "computer-use-2025-01-24",
  "files-api-2025-04-14",
  "mcp-client-2025-04-04",
  "code-execution-2025-05-22",
  "extended-cache-ttl-2025-04-11",
  "web-search-2025-03-05",
  "output-128k-2025-02-19",
  "skills-2025-10-02",
].join(",");

/** A realistic full inbound header set, as captured from Claude Code. */
function claudeCodeHeaders(): Record<string, string> {
  return {
    host: "localhost:8787",
    connection: "keep-alive",
    "content-length": "31416",
    authorization: `Bearer ${OAUTH}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": ANTHROPIC_BETA,
    "user-agent": "claude-cli/2.1.278 (external, sdk-cli)",
    "x-app": "cli",
    "x-claude-code-session-id": "8f3a6b2c-1d4e-4f90-9a11-22334455aabb",
    "x-stainless-arch": "arm64",
    "x-stainless-lang": "js",
    "x-stainless-os": "MacOS",
    "x-stainless-package-version": "0.70.1",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": "v24.4.0",
    "x-stainless-timeout": "600",
    "anthropic-dangerous-direct-browser-access": "true",
    "accept-encoding": "gzip, deflate, br, zstd",
    "content-type": "application/json",
    accept: "application/json",
    "x-fest-token": "fest_identityFIXTURE1234",
  };
}

test("subscription posture forwards anthropic-beta byte-identically", () => {
  const out = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  // Not filtered, not reordered, not deduped: the set is part of what the
  // OAuth token is validated against.
  assert.equal(out.get("anthropic-beta"), ANTHROPIC_BETA);
});

test("subscription posture leaves user-agent and client telemetry untouched", () => {
  const out = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  assert.equal(out.get("user-agent"), "claude-cli/2.1.278 (external, sdk-cli)");
  assert.equal(out.get("x-app"), "cli");
  assert.equal(out.get("x-stainless-lang"), "js");
  assert.equal(out.get("x-stainless-package-version"), "0.70.1");
  assert.equal(out.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.equal(out.get("authorization"), `Bearer ${OAUTH}`);
  assert.equal(out.get("anthropic-version"), "2023-06-01");
});

test("no attribution or telemetry header of Fest's own is ever injected", () => {
  const out = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  for (const forbidden of ["x-title", "http-referer", "referer", "x-fest-proxy", "via"]) {
    assert.equal(out.get(forbidden), null, `${forbidden} must not be injected`);
  }
  // And nothing at all in our own namespace reaches Anthropic.
  for (const [name] of headerEntries(out)) {
    assert.ok(!name.startsWith("x-fest-"), `${name} leaked upstream`);
  }
});

test("Fest identity carriers and hop-by-hop headers are stripped; host is set", () => {
  const out = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  assert.equal(out.get("x-fest-token"), null);
  assert.equal(out.get("connection"), null);
  assert.equal(out.get("host"), "api.anthropic.com");
  // The caller frames the body; a stale inbound length truncates the POST.
  assert.equal(out.get("content-length"), null);
  assert.equal(out.get("transfer-encoding"), null);
});

test("accept-encoding is forced to identity so the stream can be teed", () => {
  const out = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  assert.equal(out.get("accept-encoding"), "identity");

  const kept = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
    forceIdentityEncoding: false,
  });
  assert.equal(kept.get("accept-encoding"), "gzip, deflate, br, zstd");
});

test("anthropic-version is defaulted only when absent entirely", () => {
  const headers = claudeCodeHeaders();
  delete headers["anthropic-version"];
  const out = buildUpstreamHeaders(headers, {
    posture: "key",
    upstreamHost: "api.anthropic.com",
  });
  assert.equal(out.get("anthropic-version"), "2023-06-01");

  const pinned = buildUpstreamHeaders(
    { ...claudeCodeHeaders(), "anthropic-version": "2024-10-22" },
    { posture: "key", upstreamHost: "api.anthropic.com" },
  );
  assert.equal(pinned.get("anthropic-version"), "2024-10-22");
});

test("key posture forwards just as verbatim as subscription posture", () => {
  const sub = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "subscription",
    upstreamHost: "api.anthropic.com",
  });
  const key = buildUpstreamHeaders(claudeCodeHeaders(), {
    posture: "key",
    upstreamHost: "api.anthropic.com",
  });
  assert.deepEqual(headerEntries(key), headerEntries(sub));
});

test("array-valued inbound headers survive as repeated values", () => {
  const out = buildUpstreamHeaders(
    { "x-multi": ["a", "b"], authorization: `Bearer ${OAUTH}` },
    { posture: "subscription", upstreamHost: "api.anthropic.com" },
  );
  assert.equal(out.get("x-multi"), "a, b");
});

// ── Downstream ───────────────────────────────────────────────────────────────

const REAL_RATELIMIT: Record<string, string> = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.34",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1790017200",
  "anthropic-ratelimit-unified-7d-utilization": "0.06",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1790596800",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-overage-disabled-reason": "out_of_credits",
};

function upstreamResponseHeaders(): Headers {
  return new Headers({
    ...REAL_RATELIMIT,
    "content-type": "text/event-stream",
    "request-id": "req_011CabcDEFghiJKL",
    "anthropic-request-id": "req_011CabcDEFghiJKL",
    "retry-after": "12",
    "content-encoding": "gzip",
    "content-length": "4096",
    "set-cookie": "session=leakcanary; Path=/",
    "x-should-not-appear": "nope",
  });
}

test("quota headers are relayed downstream — Claude Code's /status reads them", () => {
  const out = buildDownstreamHeaders(upstreamResponseHeaders(), { stream: true });
  for (const [name, value] of Object.entries(REAL_RATELIMIT)) {
    assert.equal(out[name], value, `${name} must reach the client`);
  }
  assert.equal(out["request-id"], "req_011CabcDEFghiJKL");
  assert.equal(out["anthropic-request-id"], "req_011CabcDEFghiJKL");
  assert.equal(out["retry-after"], "12");
});

test("cookies, encoding, length and unknown headers never reach the client", () => {
  const out = buildDownstreamHeaders(upstreamResponseHeaders(), { stream: true });
  assert.equal(out["set-cookie"], undefined);
  assert.equal(out["content-encoding"], undefined);
  assert.equal(out["content-length"], undefined);
  assert.equal(out["x-should-not-appear"], undefined);
  assert.ok(!JSON.stringify(out).includes("leakcanary"));
});

test("streaming adds the anti-buffering headers and no content-length", () => {
  const out = buildDownstreamHeaders(upstreamResponseHeaders(), { stream: true });
  assert.equal(out["cache-control"], "no-cache, no-transform");
  assert.equal(out["x-accel-buffering"], "no");
  assert.ok(!("content-length" in out));
  assert.equal(out["content-type"], "text/event-stream");
});

test("non-streaming replies default to application/json", () => {
  // text/plain makes Claude Code report "empty or malformed response".
  const out = buildDownstreamHeaders(new Headers({ "request-id": "req_1" }), { stream: false });
  assert.equal(out["content-type"], "application/json");
  assert.equal(out["cache-control"], undefined);
  assert.equal(out["x-accel-buffering"], undefined);
});

// ── parseRateLimit ───────────────────────────────────────────────────────────

test("parseRateLimit maps the real unified quota header set", () => {
  const got = parseRateLimit(new Headers(REAL_RATELIMIT));
  assert.deepEqual(got, {
    status: "allowed",
    fiveHourUtilization: 0.34,
    fiveHourStatus: "allowed",
    fiveHourResetAt: 1790017200,
    sevenDayUtilization: 0.06,
    sevenDayStatus: "allowed",
    sevenDayResetAt: 1790596800,
    representativeClaim: "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
  });
});

test("parseRateLimit returns null when upstream said nothing about quota", () => {
  assert.equal(parseRateLimit(new Headers({ "content-type": "application/json" })), null);
});

test("parseRateLimit omits non-finite numbers rather than poisoning the record", () => {
  const got = parseRateLimit(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
      "anthropic-ratelimit-unified-5h-reset": "",
      "anthropic-ratelimit-unified-7d-utilization": "Infinity",
      "anthropic-ratelimit-unified-status": "allowed",
    }),
  );
  assert.deepEqual(got, { status: "allowed" });
  // Absent, not present-and-undefined (exactOptionalPropertyTypes).
  assert.ok(!("fiveHourUtilization" in got!));
  assert.ok(!("sevenDayUtilization" in got!));
});

test("parseRateLimit returns null when every value is garbage", () => {
  const got = parseRateLimit(
    new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "n/a",
      "anthropic-ratelimit-unified-status": "   ",
    }),
  );
  assert.equal(got, null);
});
