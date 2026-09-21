/**
 * The canary is the test that guards every other test, so it needs one of its
 * own: a canary that cannot go red is worse than none, because it reads as
 * proof while proving nothing.
 *
 * Each case stages a regression the canary exists to catch — the client
 * demoting to an API key, Anthropic rejecting a relayed bearer, the oauth beta
 * flag disappearing — against a fake `claude` and a fake upstream, and asserts
 * the canary calls it. Plus the inverse: a clean run must come out PASS, or the
 * signal is noise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import http from "node:http";

const ROOT = resolve(import.meta.dirname, "..");
const FAKE_CLAUDE = join(ROOT, "test", "fixtures", "fake-claude.mjs");

/** A stand-in for api.anthropic.com. `status` decides acceptance of the relay. */
async function fakeUpstream(status: number, errorType = "authentication_error"): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: errorType, message: "no" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hello"}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

interface Run {
  readonly code: number;
  readonly out: string;
  readonly verdict: string;
  readonly checks: { id: string; status: string; detail: string }[];
  readonly history: string;
}

/** Run the canary end to end, with every real dependency replaced by a fake. */
async function runCanary(
  t: { after: (fn: () => void) => void },
  opts: { upstreamStatus?: number; upstreamErrorType?: string; env?: Record<string, string>; args?: string[]; home?: string },
): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "fest-canary-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  chmodSync(FAKE_CLAUDE, 0o755);
  const upstream = await fakeUpstream(opts.upstreamStatus ?? 200, opts.upstreamErrorType);
  t.after(() => upstream.close());

  const historyPath = join(dir, "history.jsonl");
  const proc = spawn(process.execPath, [join(ROOT, "tools", "canary.ts"), "--json", ...(opts.args ?? [])], {
    cwd: ROOT,
    env: {
      ...process.env,
      CANARY_CLAUDE_BIN: FAKE_CLAUDE,
      CANARY_UPSTREAM: upstream.url,
      CANARY_HISTORY: historyPath,
      CANARY_LOG_DIR: join(dir, "logs"),
      CANARY_TIMEOUT_MS: "20000",
      ...(opts.home ? { HOME: opts.home } : { CANARY_SKIP_PRECHECK: "1" }),
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let out = "";
  proc.stdout.on("data", (d) => (out += String(d)));
  proc.stderr.on("data", (d) => (out += String(d)));
  const [code] = (await once(proc, "close")) as [number];

  const parsed = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1));
  return { code, out, verdict: parsed.verdict, checks: parsed.checks ?? [], history: readFileSync(historyPath, "utf8") };
}

const statusOf = (run: Run, id: string): string | undefined => run.checks.find((c) => c.id === id)?.status;

test("a clean run passes and is recorded", async (t) => {
  const run = await runCanary(t, {});

  assert.equal(run.verdict, "pass");
  assert.equal(run.code, 0);
  assert.equal(statusOf(run, "a.bearer"), "pass");
  assert.equal(statusOf(run, "a.nokey"), "pass");
  assert.equal(statusOf(run, "a.beta"), "pass");
  assert.equal(statusOf(run, "e.accepted"), "pass");
  assert.equal(statusOf(run, "e.stream"), "pass");

  // The history line is the artefact a rollout decision is made from.
  const entry = JSON.parse(run.history.trim());
  assert.equal(entry.verdict, "pass");
  assert.equal(entry.version, "9.9.9");
});

test("the regression that matters: the client demotes to an API key", async (t) => {
  const run = await runCanary(t, { env: { FAKE_CLAUDE_CRED: "apikey" } });

  assert.equal(run.verdict, "fail");
  assert.equal(run.code, 1, "a failing canary must exit non-zero, or a cron will not notice");
  assert.equal(statusOf(run, "a.bearer"), "fail");
  assert.equal(statusOf(run, "a.nokey"), "fail");
  assert.match(run.out, /do NOT roll/i);
});

test("Anthropic rejecting a relayed bearer fails the run", async (t) => {
  const run = await runCanary(t, { upstreamStatus: 401 });

  assert.equal(run.verdict, "fail");
  assert.equal(run.code, 1);
  // The client half is unchanged — the canary must localise the break to the
  // upstream, not blame the release.
  assert.equal(statusOf(run, "a.bearer"), "pass");
  assert.equal(statusOf(run, "e.accepted"), "fail");
  assert.match(JSON.stringify(run.checks), /upstream statuses: 401/);
});

test("an unreachable model is inconclusive, not a failed release", async (t) => {
  // The first real run of this canary went red exactly here: a local settings
  // file pinned a model that only exists behind Fest's routing table, and
  // Anthropic answered 404. Auth was never in question.
  const run = await runCanary(t, { upstreamStatus: 404, upstreamErrorType: "not_found_error" });

  assert.equal(run.verdict, "inconclusive");
  assert.equal(run.code, 2);
  assert.match(run.out, /says nothing about pass-through/);
});

test("losing the oauth beta flag is caught", async (t) => {
  const run = await runCanary(t, { env: { FAKE_CLAUDE_BETA: "fine-grained-tool-streaming-2025-05-14" } });

  assert.equal(statusOf(run, "a.beta"), "fail");
  assert.equal(run.verdict, "fail");
});

test("--observe-only is PARTIAL, never PASS", async (t) => {
  const run = await runCanary(t, { args: ["--observe-only"] });

  // Half a gate reported as a pass is how a team ships on an untested release.
  assert.equal(run.verdict, "partial");
  assert.equal(statusOf(run, "e.accepted"), "skip");
  assert.equal(statusOf(run, "a.bearer"), "pass");
});

test("no requests reaching the server is inconclusive, not a pass", async (t) => {
  const run = await runCanary(t, { env: { FAKE_CLAUDE_SILENT: "1" } });

  assert.equal(run.verdict, "inconclusive");
  assert.equal(run.code, 2);
});

test("a missing claude binary is inconclusive", async (t) => {
  const run = await runCanary(t, { env: { CANARY_CLAUDE_BIN: "/nonexistent/claude" } });

  assert.equal(run.verdict, "inconclusive");
  assert.equal(run.code, 2);
  assert.match(run.out, /installed/i);
});

test("preflight refuses to run when a settings layer would demote the client", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "fest-canary-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { seatTier: "max" } }));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-REAL" } }));

  const run = await runCanary(t, { home });

  assert.equal(run.verdict, "inconclusive");
  assert.equal(run.code, 2);
  assert.match(run.out, /env\.ANTHROPIC_API_KEY/);
  // The finding names the key; it must never quote the value.
  assert.doesNotMatch(run.out, /sk-ant-api03-REAL/);
});

test("preflight refuses to run without a subscription login", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "fest-canary-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ someOtherKey: true }));

  const run = await runCanary(t, { home });

  assert.equal(run.verdict, "inconclusive");
  assert.match(run.out, /API-key login/i);
});
