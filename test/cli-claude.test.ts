/**
 * `buildClaudeEnv`: the child environment `fest claude` spawns into.
 *
 * Pure function, tested without spawning a real `claude` binary. The one
 * property that matters: every var in `shared/demotion-vars.ts` is gone from
 * the child even when present in the parent, so a developer can never be
 * silently demoted off their own subscription by an inherited env var.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEMOTION_VARS } from "../shared/demotion-vars.ts";
import { buildClaudeEnv } from "../cli/claude.ts";

test("sets ANTHROPIC_BASE_URL to the path-prefixed identity carrier", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin" }, { serverUrl: "http://localhost:8787", identityToken: "fest_abc" });
  assert.equal(env["ANTHROPIC_BASE_URL"], "http://localhost:8787/t/fest_abc");
  assert.equal(env["PATH"], "/usr/bin");
});

test("strips every demotion var even when present in the parent env", () => {
  const parent: Record<string, string> = { PATH: "/usr/bin" };
  for (const v of DEMOTION_VARS) parent[v] = "poisoned";

  const env = buildClaudeEnv(parent, { serverUrl: "http://localhost:8787", identityToken: "fest_abc" });

  for (const v of DEMOTION_VARS) {
    if (v === "ANTHROPIC_BASE_URL") continue;
    assert.equal(env[v], undefined, `${v} must not reach the child`);
  }
  // The one demotion var Fest itself sets is set to Fest's own value, not the
  // parent's poisoned one.
  assert.equal(env["ANTHROPIC_BASE_URL"], "http://localhost:8787/t/fest_abc");
});

test("does not mutate the base env object passed in", () => {
  const parent = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "poisoned" };
  buildClaudeEnv(parent, { serverUrl: "http://localhost:8787", identityToken: "t" });
  assert.equal(parent.ANTHROPIC_API_KEY, "poisoned");
});
