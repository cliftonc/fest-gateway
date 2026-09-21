/**
 * End-to-end guard for the Phase 0 capture server.
 *
 * The capture server exists to observe real subscription credentials, so a
 * redaction regression here would write a developer's live Max token to disk.
 * This test drives the real binary over a real socket and asserts that no
 * credential value survives in the log, across all three carriers Fest uses:
 * the Authorization bearer, the X-Fest-Token header, and a path-prefix token.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

const OAUTH_SECRET = "sk-ant-oat01-AAAALEAKCANARYAAAA";
const HEADER_SECRET = "fest_headerLEAKCANARY111";
const PATH_SECRET = "fest_pathLEAKCANARY222";

async function waitForListening(proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  let buffered = "";
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      once(proc.stderr!, "data").then(([d]) => String(d)),
      new Promise<string>((r) => setTimeout(() => r(""), 250)),
    ]);
    buffered += chunk;
    if (buffered.includes("capture-server:")) return;
  }
  throw new Error(`capture server did not start; stderr was: ${buffered}`);
}

test("capture server records credential kinds without leaking any value", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fest-capture-"));
  const logPath = join(dir, "capture.jsonl");
  const port = 8900 + Math.floor(Math.random() * 90);

  const proc = spawn(process.execPath, ["tools/capture-server.ts"], {
    env: { ...process.env, PORT: String(port), LOG: logPath, MODE: "observe" },
    stdio: ["ignore", "ignore", "pipe"],
  });

  t.after(() => {
    proc.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  });

  await waitForListening(proc);

  const res = await fetch(`http://127.0.0.1:${port}/t/${PATH_SECRET}/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OAUTH_SECRET}`,
      "x-fest-token": HEADER_SECRET,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-opus-5",
      stream: true,
      system: [{ type: "text", text: "You are Claude Code", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    }),
  });

  // observe mode must never forward, and must say so in an Anthropic-shaped error.
  assert.equal(res.status, 501);
  const errBody = (await res.json()) as { error?: { type?: string } };
  assert.equal(errBody.error?.type, "api_error");

  const raw = readFileSync(logPath, "utf8");

  // The whole point: no credential value in the log, in any carrier.
  for (const secret of [OAUTH_SECRET, HEADER_SECRET, PATH_SECRET]) {
    assert.ok(!raw.includes(secret), `full credential leaked: ${secret.slice(0, 12)}…`);
  }
  for (const canary of ["LEAKCANARY"]) {
    assert.ok(!raw.includes(canary), "credential tail leaked into log");
  }

  const entry = JSON.parse(raw.trim().split("\n")[0]!);

  // Both credential positions are identified, and never conflated.
  assert.deepEqual([...entry.credentialKinds].sort(), [
    "ANTHROPIC_OAUTH_SUBSCRIPTION",
    "FEST_IDENTITY_TOKEN",
  ]);

  // Path identity is reduced to a fingerprint in the recorded URL.
  assert.match(entry.url, /^\/t\/<fp:[0-9a-f]{12}>\/v1\/messages$/);
  assert.equal(entry.identityFromPath.remainder, "/v1/messages");

  // Diagnostics we actually need must still be present.
  assert.equal(entry.anthropic_beta, "oauth-2025-04-20");
  assert.equal(entry.body.model, "claude-opus-5");
  assert.equal(entry.body.stream, true);
  // cache_control must be observable — Fest has to forward it verbatim.
  assert.deepEqual(entry.body.system_cache_control, ["ephemeral"]);
  // Prompt text is capped, not stored wholesale.
  assert.ok(entry.body.system_head.length <= 200);
});
