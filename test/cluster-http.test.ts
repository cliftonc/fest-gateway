/**
 * `FEST_WORKERS` > 1 against the real binary: a primary, two forked workers,
 * one SQLite file.
 *
 * Everything the cluster changes is a seam between processes, so nothing short
 * of real processes can test it: usage crossing IPC to the one writer, the live
 * feed crossing back to a dashboard on a DIFFERENT worker, migrations running
 * exactly once, a worker crash being survivable, and shutdown persisting what
 * was in flight in every process.
 *
 * Requests go out on fresh connections (`agent: false`). The cluster balances
 * connections, not requests, so a keep-alive pool would pin them all to one
 * worker and the cross-worker assertions would prove nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(import.meta.dirname, "..");
const N = 20;

async function freePort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** Anthropic-shaped SSE with a known usage, so every row is checkable. */
async function sseUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"output_tokens":1}}}\n\n',
      );
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** One request on its own connection. */
function call(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        agent: false,
        headers:
          body === undefined
            ? {}
            : { authorization: "Bearer sk-ant-oat01-SUBSCRIPTION", "content-type": "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const message = (port: number) =>
  call(port, "POST", "/v1/messages", JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }));

async function workerIdsAnswering(port: number, tries: number): Promise<Set<number>> {
  const ids = new Set<number>();
  for (let i = 0; i < tries; i += 1) {
    const res = await call(port, "GET", "/healthz").catch(() => null);
    if (res?.status === 200) ids.add((JSON.parse(res.body) as { worker: number }).worker);
  }
  return ids;
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function childPids(pid: number): number[] {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/** Subscribe to `/api/live` and collect every row id it delivers. */
function liveIds(port: number): { ids: Set<string>; ready: Promise<void>; stop: () => void } {
  const ids = new Set<string>();
  const controller = new AbortController();
  let markReady: () => void = () => {};
  const ready = new Promise<void>((r) => (markReady = r));
  void (async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/live`, { signal: controller.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.includes(": connected")) markReady();
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (data === undefined || !frame.includes("event: usage")) continue;
        for (const row of (JSON.parse(data.slice(6)) as { rows: Array<{ id: string }> }).rows) ids.add(row.id);
      }
    }
  })().catch(() => {});
  return { ids, ready, stop: () => controller.abort() };
}

test("two workers, one writer: usage, live feed, crash and shutdown", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fest-cluster-"));
  const db = join(dir, "fest.db");
  const upstream = await sseUpstream();
  const port = await freePort();

  // Only this test's FEST_* settings: a developer's own .env must not leak in.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("FEST_")),
  );
  Object.assign(env, {
    FEST_WORKERS: "2",
    FEST_HOST: "127.0.0.1",
    FEST_PORT: String(port),
    FEST_DB: db,
    FEST_USAGE_LOG: join(dir, "usage.jsonl"),
    FEST_UPSTREAM_BASE_URL: upstream.url,
    FEST_PRICING_REFRESH: "off",
  });

  let output = "";
  const proc: ChildProcess = spawn(process.execPath, [join(ROOT, "server", "bin", "fest.ts"), "serve"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  proc.stderr?.on("data", (c: Buffer) => (output += c.toString("utf8")));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));

  t.after(async () => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  try {
    await until("both workers to answer", async () => (await workerIdsAnswering(port, 6)).size === 2);
    assert.equal((output.match(/fest: http:\/\//g) ?? []).length, 1, "the banner prints once, not per worker");
    assert.equal(
      (output.match(/store migrated/g) ?? []).length,
      1,
      "migrations run once, in the primary, before any worker exists",
    );

    // A dashboard attached to whichever worker took this connection.
    const live = liveIds(port);
    await live.ready;

    const results = await Promise.all(Array.from({ length: N }, () => message(port)));
    assert.ok(results.every((r) => r.status === 200), "every relayed request succeeds");

    await until("every request on the live feed", () => live.ids.size === N);
    live.stop();

    // A worker crash: only its own process goes, and it comes back.
    const before = childPids(proc.pid ?? 0);
    assert.equal(before.length, 2, "two worker processes");
    process.kill(before[0] ?? 0, "SIGKILL");
    await until("the crashed worker to be replaced", () => {
      const now = childPids(proc.pid ?? 0);
      return now.length === 2 && !now.includes(before[0] ?? 0);
    });
    await until("both workers to answer again", async () => (await workerIdsAnswering(port, 6)).size === 2);
    const after = await Promise.all(Array.from({ length: 4 }, () => message(port)));
    assert.ok(after.every((r) => r.status === 200), "requests succeed after a respawn");

    proc.kill("SIGTERM");
    let hung: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      exited,
      new Promise<never>((_, reject) => (hung = setTimeout(() => reject(new Error("shutdown hung")), 15_000))),
    ]).finally(() => clearTimeout(hung));
    assert.equal(code, 0, `primary exits cleanly\n${output}`);
  } catch (err) {
    // The child's own output is the only useful diagnosis of a process seam.
    t.diagnostic(output);
    throw err;
  }

  // Everything that completed — before the crash and after it — persisted
  // through the one writer.
  const store = new DatabaseSync(db, { readOnly: true });
  try {
    const row = store.prepare("SELECT COUNT(*) AS n, SUM(output_tokens) AS out FROM requests").get() as {
      n: number;
      out: number;
    };
    assert.equal(row.n, N + 4);
    assert.equal(row.out, (N + 4) * 42);
  } finally {
    store.close();
  }
});
