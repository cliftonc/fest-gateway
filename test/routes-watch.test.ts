/**
 * Hot-reloading the routing table.
 *
 * The rule worth testing is the failure case, not the success case: a table
 * that does not validate must be REJECTED with the previous one left in force.
 * Degrading to "no routing" on a typo would silently push substituted traffic
 * back onto developers' subscriptions — the exact silent-billing-substitution
 * this project exists to prevent, triggered by a stray comma.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchRoutes } from "../server/routes/watch.ts";
import { parseRouteTable } from "../server/routes/table.ts";

const config = (model: string): string =>
  JSON.stringify({
    upstreams: {
      fw: { adapter: "fireworks", baseUrl: "https://x.test", credential: "{env:K}" },
    },
    routes: [{ id: "r", match: "claude-sonnet-*", upstream: "fw", model }],
  });

/** Watchers are event-driven; poll briefly rather than sleeping a fixed time. */
async function until(fn: () => boolean, ms = 6000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test("a valid edit is picked up without a restart", async () => {
  // Allow up to the backstop poll interval: fs.watch alone drops events fired
  // right after the watcher attaches, which is exactly this scenario.
  const dir = mkdtempSync(join(tmpdir(), "fest-watch-"));
  const path = join(dir, "routes.json");
  writeFileSync(path, config("model-a"));
  const w = watchRoutes(path, parseRouteTable(config("model-a")));
  try {
    assert.equal(w.current().routes[0]?.model, "model-a");
    writeFileSync(path, config("model-b"));
    assert.ok(await until(() => w.current().routes[0]?.model === "model-b"), "edit was not picked up");
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an INVALID edit is rejected and the previous table stays in force", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fest-watch-"));
  const path = join(dir, "routes.json");
  const good = parseRouteTable(config("model-a"));
  writeFileSync(path, config("model-a"));
  const w = watchRoutes(path, good);
  try {
    writeFileSync(path, "{ this is not json");
    // Give the watcher every chance to do the wrong thing.
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(
      w.current().version,
      good.version,
      "a typo must change nothing — degrading to no-routing would silently re-bill developers",
    );
    assert.equal(w.current().routes.length, 1);
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rejected edit does not prevent a later good one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fest-watch-"));
  const path = join(dir, "routes.json");
  writeFileSync(path, config("model-a"));
  const w = watchRoutes(path, parseRouteTable(config("model-a")));
  try {
    writeFileSync(path, "{ broken");
    await new Promise((r) => setTimeout(r, 300));
    writeFileSync(path, config("model-c"));
    assert.ok(await until(() => w.current().routes[0]?.model === "model-c"), "recovery after a bad edit failed");
  } finally {
    w.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watching a path that does not exist is not fatal", () => {
  // Some container mounts cannot be watched. The gateway must still run; it
  // simply will not notice edits.
  const table = parseRouteTable(config("model-a"));
  const w = watchRoutes(join(tmpdir(), `fest-absent-${Date.now()}.json`), table);
  assert.equal(w.current().version, table.version);
  assert.doesNotThrow(() => w.stop());
});
