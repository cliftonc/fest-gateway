/**
 * Copilot CLI through the `/copilot/<plan>` mount, driven against real sockets,
 * the real store and the real writer — and the proof that the developer's
 * GitHub token is forwarded and never kept.
 *
 * The mock upstream reproduces what Copilot CLI 1.0.96 saw from
 * api.individual.githubcopilot.com: `x-quota-snapshot-*` and
 * `x-github-request-id` on responses, `copilot_usage` alongside the stock
 * `usage` on `response.completed`, and an MCP server that hands out
 * `mcp-session-id`. It also misbehaves on request: it refuses with the token
 * echoed into the body and headers, dies mid-stream, and drops the connection,
 * because those are the paths where a credential ends up in an error message,
 * a log line or a row.
 *
 * "Never kept" is checked the only way that means anything: every file Fest
 * wrote (SQLite, its WAL, the JSONL trail) and every line it logged is scanned
 * for the token's secret part after the traffic has gone through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import { openStore, migrate } from "../server/store/db.ts";
import { createRequestWriter } from "../server/store/write.ts";
import { ensureOrg, ensureUser } from "../server/store/bootstrap.ts";
import { createToken, resolveToken } from "../server/store/tokens.ts";
import { splitCopilotMount, copilotWire } from "../server/pipeline/copilot.ts";
import type { UsageRecord } from "../shared/types.ts";

/** The secret part is what must never appear; `gho_` alone is just a family. */
const GH_SECRET = "Q7xYv2KpL9mN4rT8wZ3bC6dF1gH5jS0aE2uI";
const GH = `gho_${GH_SECRET}`;
const SESSION = "7c8ab512-709c-4e6f-a76e-e65b9984e517";
const GZIPPED_RESPONSES = gzipSync(JSON.stringify({ model: "gpt-6-luna-gz", stream: true }));

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

const RESPONSES_STREAM =
  'event: response.created\ndata: {"type":"response.created","response":{"usage":null}}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"pong"}\n\n' +
  "event: response.completed\n" +
  'data: {"type":"response.completed","copilot_usage":{"token_details":[{"token_count":14831,"token_type":"cache_write"}],"total_nano_aiu":185667500},' +
  '"response":{"model":"gpt-6-luna","usage":{"input_tokens":14834,"input_tokens_details":{"cached_tokens":0,"cache_write_tokens":14831},"output_tokens":5}}}\n\n';

const CHAT_STREAM =
  'data: {"choices":[{"delta":{"content":"po"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"ng"}}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":812,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":768}}}\n\n' +
  "data: [DONE]\n\n";

async function mockGitHub(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, headers: req.headers, body: Buffer.concat(chunks) });
      const common = {
        "x-github-request-id": "F07B:254D4E:1A4B2D7",
        "x-quota-snapshot-chat": "crUsed=2&ent=200&rem=98.5&rst=2026-11-01T00%3A00%3A00Z",
        "set-cookie": "_gh_sess=secret; path=/",
      };
      if (path.startsWith("/business/")) {
        // A connection that dies before answering: the relay's catch path.
        req.socket.destroy();
        return;
      }
      if (req.headers["x-test"] === "refuse") {
        // The worst an upstream can do: echo the credential back, in the body
        // and in a header, on an error the relay records and logs.
        res.writeHead(401, {
          ...common,
          "content-type": "application/json",
          "www-authenticate": `Bearer error="invalid_token", token="${String(req.headers.authorization)}"`,
          "x-echo-auth": String(req.headers.authorization),
        });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: `Bad credentials: ${String(req.headers.authorization)}` } }));
        return;
      }
      if (req.headers["x-test"] === "die") {
        res.writeHead(200, { ...common, "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (path === "/mcp/readonly") {
        res.writeHead(200, { ...common, "content-type": "text/event-stream", "mcp-session-id": "mcp-sess-1" });
        res.end('event: message\ndata: {"jsonrpc":"2.0","id":0,"result":{}}\n\n');
        return;
      }
      if (path === "/individual/models" || path === "/individual/auto") {
        res.writeHead(200, { ...common, "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-6-luna" }] }));
        return;
      }
      if (path === "/individual/responses") {
        res.writeHead(200, { ...common, "content-type": "text/event-stream" });
        res.end(RESPONSES_STREAM);
        return;
      }
      if (path === "/individual/chat/completions") {
        res.writeHead(200, { ...common, "content-type": "text/event-stream" });
        res.end(CHAT_STREAM);
        return;
      }
      if (path === "/individual/v1/messages") {
        res.writeHead(200, { ...common, "content-type": "application/json" });
        res.end(JSON.stringify({
          type: "message",
          model: "claude-sonnet-4.5",
          content: [{ type: "text", text: "pong" }],
          usage: { input_tokens: 20, output_tokens: 3, cache_read_input_tokens: 100 },
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Everything written to stderr while `fn` runs: that is where `log` goes. */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    return { result: await fn(), text: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

/** What Copilot CLI sends on a model call, plus whatever a case adds. */
function copilotHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${GH}`,
    "content-type": "application/json",
    "copilot-integration-id": "copilot-developer-cli",
    "editor-version": "copilot/1.0.96",
    "x-client-session-id": SESSION,
    "x-initiator": "user",
    "x-interaction-type": "conversation-user",
    "user-agent": "copilot/1.0.96 (darwin v24.20.0)",
    ...extra,
  };
}

test("the mount path splits into a plan and the path to relay", () => {
  assert.deepEqual(splitCopilotMount("/copilot/individual/responses"), { plan: "individual", rest: "/responses" });
  assert.deepEqual(splitCopilotMount("/copilot/business/models?x=1"), { plan: "business", rest: "/models?x=1" });
  assert.deepEqual(splitCopilotMount("/copilot/enterprise"), { plan: "enterprise", rest: "/" });
  assert.deepEqual(splitCopilotMount("/copilot/evil.example.com/x"), { plan: null, rest: "/x" });
  assert.equal(splitCopilotMount("/copilotish/individual/x"), null);
  assert.equal(splitCopilotMount("/v1/messages"), null);
});

test("only the three model calls are metered", () => {
  assert.equal(copilotWire("POST", "/v1/messages")?.id, "anthropic");
  assert.equal(copilotWire("POST", "/responses")?.id, "openai-responses");
  assert.equal(copilotWire("POST", "/chat/completions")?.id, "openai-chat");
  assert.equal(copilotWire("GET", "/models"), null);
  assert.equal(copilotWire("POST", "/auto"), null);
});

test("Copilot traffic is relayed and metered, and the GitHub token is never kept", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fest-copilot-"));
  const upstream = await mockGitHub();
  const store = openStore(join(dir, "fest.db"));
  migrate(store);
  const org = ensureOrg(store);
  const user = ensureUser(store, { orgId: org.id, email: "dev@corp.test" });
  const fest = createToken(store, { orgId: org.id, userId: user.id }).raw;
  const writer = createRequestWriter(store);
  const sink = createUsageSink({
    path: join(dir, "usage.jsonl"),
    flushMs: 10,
    onBatch: (records) => writer.writeBatch(org.id, records),
  });
  const server = createServer({
    config: {
      ...loadConfig(),
      requireIdentity: true,
      copilotBaseUrl: `${upstream.url}/{plan}`,
      copilotMcpBaseUrl: upstream.url,
      // Anything that reaches Anthropic or OpenAI instead must fail loudly.
      upstreamBaseUrl: "http://127.0.0.1:1",
      openaiBaseUrl: "http://127.0.0.1:1",
      chatgptBaseUrl: "http://127.0.0.1:1",
    },
    sink,
    bus: createLiveBus(),
    orgId: org.id,
    store,
    resolveIdentity: (raw) => resolveToken(store, raw),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const mount = `${base}/t/${fest}/copilot/individual`;
  t.after(async () => {
    await upstream.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (url: string, body: unknown, extra?: Record<string, string>) =>
    fetch(url, { method: "POST", headers: copilotHeaders(extra), body: JSON.stringify(body) });

  const { result: responses, text: logged } = await captureStderr(async () => {
    const r: Record<string, { status: number; headers: Headers; body: string }> = {};
    const take = async (name: string, p: Promise<Response>) => {
      const res = await p;
      r[name] = { status: res.status, headers: res.headers, body: await res.text() };
    };
    await take("models", fetch(`${mount}/models`, { headers: copilotHeaders() }));
    await take("auto", post(`${mount}/auto`, {}));
    await take("responses", post(`${mount}/responses`, { model: "gpt-6-luna", stream: true }));
    await take("chat", post(`${mount}/chat/completions`, { model: "gpt-4.1", stream: true, stream_options: { include_usage: true } }));
    await take("messages", post(`${mount}/v1/messages`, { model: "claude-sonnet-4.5", max_tokens: 64 }));
    await take("refused", post(`${mount}/v1/messages`, { model: "claude-sonnet-4.5" }, { "x-test": "refuse" }));
    // Interactive Copilot gzips its bodies; `-p` does not.
    await take(
      "gzipResponses",
      fetch(`${mount}/responses`, {
        method: "POST",
        headers: copilotHeaders({ "content-encoding": "gzip" }),
        body: GZIPPED_RESPONSES,
      }),
    );
    await take(
      "gzipChat",
      fetch(`${mount}/chat/completions`, {
        method: "POST",
        headers: copilotHeaders({ "content-encoding": "gzip" }),
        body: gzipSync(JSON.stringify({ model: "gpt-4.1-gz", stream: true })),
      }),
    );
    await take("died", post(`${mount}/chat/completions`, { model: "gpt-4.1", stream: true }, { "x-test": "die" }));
    await take("unreachable", post(`${base}/t/${fest}/copilot/business/responses`, { model: "gpt-6-luna", stream: true }));
    await take("unreachableModels", fetch(`${base}/t/${fest}/copilot/business/models`, { headers: copilotHeaders() }));
    await take("mcp", post(`${base}/mcp/readonly`, { jsonrpc: "2.0", id: 0, method: "server/discover" }));
    await take("badIdentity", fetch(`${base}/t/fest_notarealtoken0000/copilot/individual/models`, { headers: copilotHeaders() }));
    await take("noIdentity", fetch(`${base}/copilot/individual/models`, { headers: copilotHeaders() }));
    await take("badPlan", fetch(`${base}/t/${fest}/copilot/attacker.example/models`, { headers: copilotHeaders() }));
    await sink.flush();
    return r;
  });
  await new Promise<void>((r) => server.close(() => r()));

  // ── relayed as is ────────────────────────────────────────────────────────
  for (const s of upstream.seen) {
    assert.equal(s.headers.authorization, `Bearer ${GH}`, `${s.path}: the token went upstream unchanged`);
    assert.ok(!Object.keys(s.headers).some((h) => h.startsWith("x-fest-")), `${s.path}: no Fest header upstream`);
    assert.ok(!s.path.includes(fest) && !s.path.includes("/copilot"), `${s.path}: no Fest path upstream`);
    assert.equal(s.headers["anthropic-version"], undefined, `${s.path}: nothing invented`);
  }
  assert.deepEqual(
    upstream.seen.map((s) => `${s.method} ${s.path}`).filter((p) => !p.includes("/business/")),
    [
      "GET /individual/models",
      "POST /individual/auto",
      "POST /individual/responses",
      "POST /individual/chat/completions",
      "POST /individual/v1/messages",
      "POST /individual/v1/messages",
      "POST /individual/responses",
      "POST /individual/chat/completions",
      "POST /individual/chat/completions",
      "POST /mcp/readonly",
    ],
  );

  assert.equal(responses["models"]!.status, 200);
  assert.equal(responses["models"]!.headers.get("x-quota-snapshot-chat")?.startsWith("crUsed=2"), true);
  assert.equal(responses["models"]!.headers.get("set-cookie"), null);
  assert.ok(responses["responses"]!.body.includes("response.completed"));
  assert.ok(responses["chat"]!.body.endsWith("data: [DONE]\n\n"));
  assert.equal(responses["mcp"]!.headers.get("mcp-session-id"), "mcp-sess-1");
  assert.equal(responses["refused"]!.status, 401);
  // The metered relay's existing contract: an upstream it never reached is an
  // `api_error`, 500. The plain relay says 502.
  assert.equal(responses["unreachable"]!.status, 500);
  assert.equal(responses["unreachableModels"]!.status, 502);
  assert.equal(responses["badIdentity"]!.status, 401);
  assert.equal(responses["noIdentity"]!.status, 401);
  assert.equal(responses["badPlan"]!.status, 404);
  // What the upstream echoed goes back to the one caller who sent it, and only
  // there: `www-authenticate` is how GitHub's MCP server starts its own auth,
  // so it is relayed. Keeping it out of Fest's logs and files is checked below.
  assert.ok(responses["refused"]!.headers.get("www-authenticate")?.includes("invalid_token"));

  // ── metered ──────────────────────────────────────────────────────────────
  const rows: readonly UsageRecord[] = sink.recent(50);
  // The model calls, and nothing else: not the model list, `/auto`, MCP, or
  // the requests refused before reaching the relay.
  assert.equal(rows.length, 8);
  for (const r of rows) {
    assert.equal(r.client, "copilot");
    assert.equal(r.posture, "subscription");
    assert.equal(r.credentialOrigin, "inbound_subscription");
    assert.equal(r.sessionId, SESSION);
    assert.equal(r.userId, user.id);
  }
  const byModel = (status: string, model: string) =>
    rows.find((r) => r.status === status && r.requestedModel === model);
  const resp = byModel("ok", "gpt-6-luna")!;
  assert.equal(resp.usage.cacheWrite5mTokens, 14831);
  assert.equal(resp.usage.inputTokens, 3);
  assert.equal(resp.usage.outputTokens, 5);
  assert.equal(resp.upstreamRequestId, "F07B:254D4E:1A4B2D7");
  const chat = byModel("ok", "gpt-4.1")!;
  assert.equal(chat.usage.inputTokens, 44);
  assert.equal(chat.usage.cacheReadTokens, 768);
  assert.equal(chat.usage.outputTokens, 5);
  assert.equal(chat.partial, false);
  assert.equal(byModel("ok", "claude-sonnet-4.5")!.usage.outputTokens, 3);
  assert.ok(byModel("upstream_error", "claude-sonnet-4.5")?.errorMessage?.startsWith("Bad credentials"));
  assert.equal(byModel("stream_error", "gpt-4.1")?.partial, true);
  assert.ok(byModel("upstream_error", "gpt-6-luna"), "the unreachable upstream is a row too");

  // A gzipped body is read through a copy and forwarded as the bytes it was.
  const gz = byModel("ok", "gpt-6-luna-gz");
  assert.ok(gz, "a gzipped body's model is read");
  assert.equal(gz.stream, true);
  assert.equal(gz.usage.cacheWrite5mTokens, 14831);
  const gzChat = byModel("ok", "gpt-4.1-gz");
  assert.equal(gzChat?.stream, true);
  assert.equal(gzChat?.usage.outputTokens, 5);
  const forwarded = upstream.seen.find((s) => s.headers["content-encoding"] === "gzip" && s.path === "/individual/responses");
  assert.ok(forwarded?.body.equals(GZIPPED_RESPONSES), "the compressed bytes went upstream unchanged");

  // ── never kept ───────────────────────────────────────────────────────────
  const leaks = (where: string, text: string) => {
    assert.ok(!text.includes(GH_SECRET), `${where} holds the GitHub token`);
    // Seven characters is all the old 11-character prefix would have kept.
    assert.ok(!text.includes(GH_SECRET.slice(0, 7)), `${where} holds part of the GitHub token`);
  };
  leaks("the log", logged);
  // Not vacuous: the refusal really was logged, with the token redacted.
  assert.match(logged, /upstream refused/);
  assert.match(logged, /<redacted>/);
  leaks("the in-memory ring", JSON.stringify(rows));

  const scanFiles = (when: string) => {
    for (const name of readdirSync(dir)) {
      leaks(`${name} (${when})`, readFileSync(join(dir, name)).toString("latin1"));
    }
  };
  scanFiles("store open");
  const stored = store.db.prepare("SELECT error_message FROM requests WHERE error_message LIKE 'Bad credentials%'").all();
  assert.equal(stored.length, 1, "the refusal's message reached the store");
  await sink.close();
  store.close();
  scanFiles("store closed");
  assert.ok(readdirSync(dir).includes("usage.jsonl"));
});
