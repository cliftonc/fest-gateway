/**
 * The live bus and its SSE projection.
 *
 * Two properties matter more than the plumbing:
 *
 *  1. A slow subscriber must be DROPPED FROM, not buffered for. A dashboard
 *     that stops reading must never be able to grow the gateway's memory.
 *  2. The projection must not leak. `UsageRecord` is deliberately close to the
 *     wire, so a spread would ship every future record field to the browser.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { toLiveRow } from "../server/api/live.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord } from "../shared/types.ts";

const BEARER = "sk-ant-oat01-LIVEFEEDFIXTUREBEARERVALUE";

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: "req-1",
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "abc123def456",
    userId: "user-1",
    tokenId: "tok-1",
    credentialFingerprint: "fff000fff000",
    credentialOrigin: "inbound_subscription",
    sessionId: "sess-1",
    requestedModel: "claude-opus-5",
    servedModel: "claude-opus-5",
    upstream: "https://api.anthropic.com",
    stream: true,
    status: "ok",
    httpStatus: 200,
    partial: false,
    usage: { ...EMPTY_USAGE, inputTokens: 7, outputTokens: 3 },
    costUsd: null,
    costBasis: "subscription",
    ttfbMs: 1444,
    durationMs: 2000,
    bytesIn: 100,
    bytesOut: 200,
    upstreamRequestId: "req_upstream_1",
    rateLimit: { fiveHourUtilization: 0.41, representativeClaim: "five_hour" },
    clientVersion: "2.1.278",
    ...over,
  };
}

test("a subscriber receives published batches", () => {
  const bus = createLiveBus();
  const seen: string[] = [];
  bus.subscribe((records) => {
    seen.push(...records.map((r) => r.id));
    return true;
  });

  bus.publish([record({ id: "a" }), record({ id: "b" })]);
  assert.deepEqual(seen, ["a", "b"]);
  assert.equal(bus.stats().published, 2);
});

test("publishing with no subscribers is free and counts nothing", () => {
  const bus = createLiveBus();
  bus.publish([record()]);
  assert.deepEqual(bus.stats(), { subscribers: 0, published: 0, dropped: 0 });
});

test("an empty batch is not published", () => {
  const bus = createLiveBus();
  bus.subscribe(() => true);
  bus.publish([]);
  assert.equal(bus.stats().published, 0);
});

test("a subscriber that refuses a frame is counted as a drop, not retried", () => {
  const bus = createLiveBus();
  let calls = 0;
  bus.subscribe(() => {
    calls += 1;
    return false;
  });

  bus.publish([record(), record()]);
  assert.equal(calls, 1);
  assert.equal(bus.stats().dropped, 2, "the whole refused batch is counted lost");
  assert.equal(bus.stats().subscribers, 1, "refusing a frame does not disconnect");
});

test("a throwing subscriber is removed so one bad socket cannot be retried forever", () => {
  const bus = createLiveBus();
  let calls = 0;
  bus.subscribe(() => {
    calls += 1;
    throw new Error("socket destroyed");
  });

  bus.publish([record()]);
  bus.publish([record()]);
  assert.equal(calls, 1);
  assert.equal(bus.stats().subscribers, 0);
});

test("one failing subscriber does not stop the others", () => {
  const bus = createLiveBus();
  let delivered = 0;
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe(() => {
    delivered += 1;
    return true;
  });

  bus.publish([record()]);
  assert.equal(delivered, 1);
});

test("unsubscribe stops delivery", () => {
  const bus = createLiveBus();
  let delivered = 0;
  const off = bus.subscribe(() => {
    delivered += 1;
    return true;
  });
  bus.publish([record()]);
  off();
  bus.publish([record()]);
  assert.equal(delivered, 1);
  assert.equal(bus.stats().subscribers, 0);
});

test("the live row projects only the fields the dashboard renders", () => {
  const row = toLiveRow(record());

  // `seq` is null by design: the flush publishes before the rowid is read back,
  // and inventing a cursor here would corrupt keyset pagination.
  assert.equal(row.seq, null);
  assert.equal(row.rl5hUtilization, 0.41);
  assert.equal(row.rlClaim, "five_hour");
  assert.equal(row.errorType, null, "an absent error type is null, not undefined");

  // Enumerated, not spread. If a field is added to UsageRecord it must be
  // added here deliberately — which is the point of this assertion.
  const keys = Object.keys(row).sort();
  assert.deepEqual(keys, [
    "clientVersion",
    "costBasis",
    "costUsd",
    "credentialFingerprint",
    "credentialOrigin",
    "durationMs",
    "errorType",
    "httpStatus",
    "id",
    "partial",
    "posture",
    "requestedModel",
    "rl5hUtilization",
    "rlClaim",
    "seq",
    "servedModel",
    "sessionId",
    "startedAt",
    "status",
    "stream",
    "ttfbMs",
    "usage",
    "userId",
  ]);

  for (const hidden of ["tokenId", "callerFingerprint", "errorMessage", "upstreamRequestId", "upstream", "bytesIn", "bytesOut"]) {
    assert.equal(hidden in row, false, `${hidden} must not reach the browser`);
  }
});

test("no part of a bearer can reach a live frame", () => {
  // The record type has no field a bearer could occupy, which is the real
  // guarantee; this asserts the projection has not grown one.
  const row = toLiveRow(record({ credentialFingerprint: "aabbccddeeff" }));
  const serialised = JSON.stringify(row);
  assert.equal(serialised.includes(BEARER), false);
  assert.equal(serialised.includes("sk-ant"), false);
});
