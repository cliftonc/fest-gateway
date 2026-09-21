/**
 * `/api/live` over a real socket.
 *
 * The unit tests cover the bus; this covers the thing only a socket can show:
 * that a frame published after a client connects actually reaches it, framed as
 * SSE, without the response being buffered until close.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { handleLive } from "../server/api/live.ts";
import { EMPTY_USAGE } from "../shared/types.ts";
import type { UsageRecord } from "../shared/types.ts";

function record(id: string): UsageRecord {
  return {
    id,
    startedAt: Date.now(),
    endedAt: Date.now(),
    posture: "subscription",
    identityCarrier: "path",
    callerFingerprint: "aaaabbbbcccc",
    userId: "user-1",
    tokenId: "tok-1",
    credentialFingerprint: "ddddeeeeffff",
    credentialOrigin: "inbound_subscription",
    sessionId: "sess-1",
    requestedModel: "claude-opus-5",
    servedModel: "claude-opus-5",
    upstream: "https://api.anthropic.com",
    stream: true,
    status: "ok",
    httpStatus: 200,
    partial: false,
    usage: { ...EMPTY_USAGE, inputTokens: 5, outputTokens: 2 },
    costUsd: null,
    costBasis: "subscription",
    ttfbMs: 900,
    durationMs: 1500,
    bytesIn: 10,
    bytesOut: 20,
    upstreamRequestId: "req_x",
    rateLimit: null,
    clientVersion: "2.1.278",
    pipeline: "passthrough",
    routeId: null,
    credentialsConsidered: [{ source: "inbound_subscription", result: "used" }],
  };
}

test("a record published after connect arrives as an SSE usage frame", async () => {
  const bus = createLiveBus();
  const server = http.createServer((req, res) => handleLive(req, res, bus));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/live`);
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    assert.match(res.headers.get("cache-control") ?? "", /no-transform/);
    assert.equal(res.headers.get("x-accel-buffering"), "no");

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    // The greeting comment proves headers and a first byte flushed before any
    // traffic existed — i.e. nothing is holding the response open-but-silent.
    const greeting = decoder.decode((await reader.read()).value);
    assert.match(greeting, /^: connected/);

    // Publish only once the subscriber is definitely attached; otherwise the
    // test races the bus and passes or fails on scheduling.
    await new Promise((r) => setTimeout(r, 50));
    bus.publish([record("req-live-1"), record("req-live-2")]);

    let buffer = "";
    while (!buffer.includes("\n\n") || !buffer.includes("event: usage")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }

    assert.match(buffer, /event: usage/);
    const line = buffer.split("\n").find((l) => l.startsWith("data: "));
    assert.ok(line !== undefined, "a data line must accompany the event");
    const frame = JSON.parse(line.slice(6)) as { rows: Array<{ id: string; seq: null }> };
    assert.deepEqual(
      frame.rows.map((r) => r.id),
      ["req-live-1", "req-live-2"],
      "a whole flush batch arrives in one frame, oldest first",
    );
    assert.equal(frame.rows[0]?.seq, null);

    await reader.cancel();
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a disconnected client is unsubscribed rather than written to forever", async () => {
  const bus = createLiveBus();
  const server = http.createServer((req, res) => handleLive(req, res, bus));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  try {
    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: controller.signal });
    await (res.body as ReadableStream<Uint8Array>).getReader().read();
    assert.equal(bus.stats().subscribers, 1);

    controller.abort();
    // Give the socket's close event a turn to land.
    for (let i = 0; i < 50 && bus.stats().subscribers > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(bus.stats().subscribers, 0, "a closed socket must not stay subscribed");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
