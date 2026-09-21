/**
 * Shutdown must not be blocked by an open dashboard.
 *
 * `server.close()` stops accepting connections but waits for existing ones to
 * end, and an SSE stream never ends by itself. So one open dashboard tab held
 * the process open forever — which under `node --watch` presents as a restart
 * stuck on "Waiting for graceful termination", i.e. the dev server silently
 * stops picking up code changes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { handleLive } from "../server/api/live.ts";

test("closeAll() ends live streams so the server can actually close", async () => {
  const bus = createLiveBus();
  const server = http.createServer((req, res) => handleLive(req, res, bus));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/api/live`);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  await reader.read(); // the ": connected" greeting — the stream is live
  assert.equal(bus.stats().subscribers, 1);

  // Without closeAll() this promise never settles.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  bus.closeAll();
  server.closeIdleConnections();

  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("server.close() hung")), 3000)),
  ]);

  assert.equal(bus.stats().subscribers, 0);
  await reader.cancel().catch(() => {});
});

test("closeAll() is safe with no subscribers and safe twice", () => {
  const bus = createLiveBus();
  assert.doesNotThrow(() => bus.closeAll());
  bus.subscribe(() => true);
  bus.closeAll();
  assert.doesNotThrow(() => bus.closeAll());
  assert.equal(bus.stats().subscribers, 0);
});

test("a subscriber whose close hook throws does not block the others", () => {
  const bus = createLiveBus();
  let secondClosed = false;
  bus.subscribe(
    () => true,
    () => {
      throw new Error("socket already destroyed");
    },
  );
  bus.subscribe(
    () => true,
    () => {
      secondClosed = true;
    },
  );
  bus.closeAll();
  assert.equal(secondClosed, true, "one dead socket must not strand the rest");
});
