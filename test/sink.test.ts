import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsageSink } from "../server/ingest/sink.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord } from "../shared/types.ts";

function rec(id: string): UsageRecord {
  return {
    id,
    startedAt: 1,
    endedAt: 2,
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "abc123",
    userId: "usr_1",
    tokenId: "tok_1",
    credentialFingerprint: "def456",
    credentialOrigin: "inbound_subscription",
    sessionId: "sess-1",
    requestedModel: "claude-opus-5",
    servedModel: "claude-opus-5",
    upstream: "anthropic",
    stream: true,
    status: "ok",
    httpStatus: 200,
    partial: false,
    usage: EMPTY_USAGE,
    costUsd: null,
    costBasis: "subscription",
    notionalCostUsd: null,
    ttfbMs: 100,
    durationMs: 200,
    bytesIn: 10,
    bytesOut: 20,
    upstreamRequestId: "req_1",
    rateLimit: null,
    clientVersion: "claude-cli/2.1.278",
    pipeline: "passthrough",
    routeId: null,
    credentialsConsidered: [{ source: "inbound_subscription", result: "used" }],
  };
}

function withSink(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "fest-sink-"));
  const path = join(dir, "usage.jsonl");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path };
}

test("record() does no I/O, so it is safe on the hot path", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000 });
  sink.record(rec("a"));
  // Nothing may have been written yet: the flush is deferred deliberately so a
  // disk write can never sit between upstream and the developer's terminal.
  assert.equal(existsSync(path), false);
  assert.equal(sink.stats().queued, 1);
  await sink.close();
  assert.equal(sink.stats().written, 1);
});

test("flush appends newline-delimited JSON", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000 });
  sink.record(rec("a"));
  sink.record(rec("b"));
  await sink.flush();
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]!).id, "a");
  assert.equal(JSON.parse(lines[1]!).id, "b");
  await sink.close();
});

test("overflow drops the oldest and counts it, never grows unbounded", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000, maxQueue: 3, maxBatch: 1000 });
  for (const id of ["a", "b", "c", "d", "e"]) sink.record(rec(id));

  // An accounting record is worth less than an in-flight session, so we degrade
  // the metric rather than the proxy.
  assert.equal(sink.stats().queued, 3);
  assert.equal(sink.stats().dropped, 2);

  await sink.flush();
  const ids = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
  // Oldest dropped, newest retained.
  assert.deepEqual(ids, ["c", "d", "e"]);
  await sink.close();
});

test("a size burst triggers a flush without waiting for the timer", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000, maxBatch: 2 });
  sink.record(rec("a"));
  sink.record(rec("b"));
  // Give the fire-and-forget flush a turn of the loop.
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(sink.stats().written >= 2, `expected a flush, wrote ${sink.stats().written}`);
  await sink.close();
});

test("recent() returns newest first for the admin endpoint", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000, ringSize: 3 });
  for (const id of ["a", "b", "c", "d"]) sink.record(rec(id));
  assert.deepEqual(sink.recent().map((r) => r.id), ["d", "c", "b"]);
  assert.deepEqual(sink.recent(2).map((r) => r.id), ["d", "c"]);
  await sink.close();
});

test("close drains everything already queued", async (t) => {
  const { path } = withSink(t);
  const sink = createUsageSink({ path, flushMs: 60_000, maxBatch: 2 });
  for (const id of ["a", "b", "c", "d", "e"]) sink.record(rec(id));
  await sink.close();
  assert.equal(sink.stats().queued, 0);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 5);
});

test("a failing JSONL trail is counted but does not requeue", async (t) => {
  const { dir } = withSink(t);
  const persisted: string[] = [];
  // Path inside a non-existent directory: the append will fail.
  const sink = createUsageSink({
    path: join(dir, "nope", "usage.jsonl"),
    flushMs: 60_000,
    onBatch: (records) => {
      for (const r of records) persisted.push(r.id);
    },
  });
  sink.record(rec("a"));
  await sink.flush();

  // The store is the system of record and it succeeded, so the record is safe.
  assert.deepEqual(persisted, ["a"]);
  assert.equal(sink.stats().trailErrors, 1);
  assert.equal(sink.stats().writeErrors, 0);
  assert.equal(sink.stats().written, 1);
  // Crucially NOT requeued: retrying for the trail's sake would re-run
  // onBatch and duplicate rows in the store.
  assert.equal(sink.stats().queued, 0);
  await sink.close();
});

test("a failing store write requeues once and is counted", async (t) => {
  const { path } = withSink(t);
  let attempts = 0;
  const sink = createUsageSink({
    path,
    flushMs: 60_000,
    onBatch: () => {
      attempts += 1;
      throw new Error("store unavailable");
    },
  });
  sink.record(rec("a"));
  await sink.flush();

  assert.equal(sink.stats().writeErrors, 1);
  assert.equal(sink.stats().written, 0);
  // Requeued rather than lost, so a transient store failure is survivable.
  assert.equal(sink.stats().queued, 1);
  assert.equal(attempts, 1);
  await sink.close();
});

test("onBatch receives the batch and runs inside the flush, not the hot path", async (t) => {
  const { path } = withSink(t);
  const batches: string[][] = [];
  const sink = createUsageSink({
    path,
    flushMs: 60_000,
    onBatch: (records) => batches.push(records.map((r) => r.id)),
  });
  sink.record(rec("a"));
  sink.record(rec("b"));
  // Nothing persisted yet: record() must not do I/O.
  assert.deepEqual(batches, []);
  await sink.flush();
  assert.deepEqual(batches, [["a", "b"]]);
  await sink.close();
});
