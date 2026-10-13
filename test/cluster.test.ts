/**
 * The cluster's pure parts: the worker-count setting, the SQLite floor, the
 * IPC message guards and the merged sink health. The wiring between real
 * processes is cluster-http.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { workersFromEnv } from "../server/config.ts";
import { versionAtLeast, MIN_SQLITE_VERSION } from "../server/store/db.ts";
import { isToPrimary, isToWorker } from "../server/cluster/messages.ts";
import { mergeSinkStats } from "../server/cluster/worker.ts";
import type { SinkStats } from "../server/ingest/sink.ts";

test("FEST_WORKERS: unset is one process, auto is one per core, nonsense refuses to boot", () => {
  assert.equal(workersFromEnv(undefined, 8), 1);
  assert.equal(workersFromEnv("  ", 8), 1);
  assert.equal(workersFromEnv("4", 8), 4);
  assert.equal(workersFromEnv("AUTO", 8), 8);
  assert.equal(workersFromEnv("auto", 0), 1, "a host reporting no cores still gets one worker");
  for (const bad of ["0", "-2", "1.5", "two"]) {
    assert.throws(() => workersFromEnv(bad, 8), /FEST_WORKERS/, bad);
  }
});

test("versionAtLeast compares numerically, not lexically", () => {
  assert.equal(versionAtLeast("3.51.3", "3.51.3"), true);
  assert.equal(versionAtLeast("3.53.0", "3.51.3"), true);
  assert.equal(versionAtLeast("3.51.2", "3.51.3"), false);
  assert.equal(versionAtLeast("3.9.0", "3.51.3"), false, "9 < 51 even though '9' > '5'");
  assert.equal(versionAtLeast("4", "3.51.3"), true);
  assert.equal(versionAtLeast("3.51", "3.51.3"), false, "a missing part counts as 0");
});

test("this Node's bundled SQLite clears the floor", () => {
  assert.ok(
    versionAtLeast(process.versions.sqlite ?? "0", MIN_SQLITE_VERSION),
    `SQLite ${process.versions.sqlite} is older than ${MIN_SQLITE_VERSION}`,
  );
});

test("IPC guards accept their own shapes and nothing else", () => {
  assert.equal(isToPrimary({ t: "usage", records: [] }), true);
  assert.equal(isToPrimary({ t: "touch", tokenId: "tok_1" }), true);
  assert.equal(isToPrimary({ t: "touch" }), false);
  assert.equal(isToPrimary({ t: "live", records: [] }), false, "a worker-bound message is not primary-bound");
  assert.equal(isToWorker({ t: "live", records: [] }), true);
  assert.equal(isToWorker({ t: "prices" }), true);
  assert.equal(isToWorker({ t: "stats", stats: {} }), true);
  assert.equal(isToWorker({ t: "usage", records: [] }), false);
  // cluster's own internal messages share the channel.
  assert.equal(isToWorker({ cmd: "NODE_CLUSTER", act: "online" }), false);
  assert.equal(isToPrimary(null), false);
  assert.equal(isToPrimary("usage"), false);
});

const stats = (s: Partial<SinkStats>): SinkStats => ({
  queued: 0,
  written: 0,
  dropped: 0,
  writeErrors: 0,
  trailErrors: 0,
  lastFlushMs: null,
  ...s,
});

test("merged sink health: the writer's totals, and every loss added up", () => {
  // The worker's own `written` counts sends to the primary, not rows stored.
  const local = stats({ queued: 3, written: 50, dropped: 1, writeErrors: 2 });
  const writer = stats({ queued: 7, written: 40, dropped: 5, writeErrors: 1, trailErrors: 4, lastFlushMs: 9 });
  assert.deepEqual(mergeSinkStats(local, writer, 6), {
    queued: 10,
    written: 40,
    dropped: 6,
    writeErrors: 9,
    trailErrors: 4,
    lastFlushMs: 9,
  });
});

test("merged sink health before the writer has reported claims nothing stored", () => {
  const merged = mergeSinkStats(stats({ written: 12, writeErrors: 1 }), null, 2);
  assert.equal(merged.written, 0);
  assert.equal(merged.writeErrors, 3);
});
