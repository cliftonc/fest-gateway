/**
 * Codex through the `/openai` and `/chatgpt` mounts, driven against real
 * sockets.
 *
 * The mock upstream reproduces what the capture server saw chatgpt.com send
 * codex-cli 0.162.1: an SSE stream with NO content-type, `x-codex-*` quota
 * headers on every response, and `x-codex-turn-state`, which Codex echoes on
 * its next request. Each of those is a way a relay can quietly break Codex or
 * lose its usage, so each is asserted on the wire.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../server/http/server.ts";
import { splitMount } from "../server/pipeline/openai.ts";
import { parseRouteTable } from "../server/routes/table.ts";
import { createEnvResolver } from "../server/credentials/provider.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import type { UsageRecord } from "../shared/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_STREAM, EXPECTED } from "./fixtures/codex-stream.ts";

/** A ChatGPT access token is a JWT; an API key is `sk-proj-…`. */
const CHATGPT_JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLWNvZGV4In0.c2lnbmF0dXJlLWJ5dGVz";
const OPENAI_KEY = "sk-proj-dGVzdGtleWZvcmNvZGV4b3ZlcmZlc3Q";
const ACCOUNT = "f1cee5b7-1285-4b05-a4d9-ec7be28d572c";
const FEST = "fest_aWRlbnRpdHl0b2tlbmZvcmNvZGV4";
const SESSION = "01a13435-dc2c-7203-95ac-43973bd9e02c";

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

async function mockUpstream(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const path = req.url ?? "";
      seen.push({ method: req.method ?? "", path, headers: req.headers });
      if (path.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json", etag: 'W/"abc"', "x-models-etag": 'W/"abc"' });
        res.end(JSON.stringify({ models: [{ slug: "gpt-6-astra" }] }));
        return;
      }
      // As chatgpt.com does it: no content-type on the stream.
      res.writeHead(200, {
        "x-codex-primary-used-percent": "4",
        "x-codex-primary-window-minutes": "300",
        "x-codex-primary-reset-at": "1791895315",
        "x-codex-secondary-used-percent": "1",
        "x-codex-secondary-reset-at": "1792482115",
        "x-codex-active-limit": "premium",
        "x-codex-turn-state": "gAAAAABturnstate",
        "set-cookie": "__cf_bm=secret; path=/",
      });
      res.end(CODEX_STREAM);
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

async function withFest(
  upstream: string,
  fn: (base: string, records: () => readonly UsageRecord[]) => Promise<void>,
  overrides: { openaiBaseUrl?: string | null; chatgptBaseUrl?: string | null } = {},
): Promise<void> {
  const sink = createUsageSink({ path: join(tmpdir(), `fest-codex-${Date.now()}-${Math.random()}.jsonl`) });
  const server = createServer({
    config: {
      ...loadConfig(),
      requireIdentity: false,
      openaiBaseUrl: upstream,
      chatgptBaseUrl: upstream,
      ...overrides,
      // Anything that reaches Anthropic instead must fail loudly.
      upstreamBaseUrl: "http://127.0.0.1:1",
    },
    sink,
    bus: createLiveBus(),
    orgId: "org-test",
    store: null as never,
    // A catch-all route that would substitute a server-held key for any model,
    // if a mount ever let routing have a say.
    routes: parseRouteTable(
      JSON.stringify({
        upstreams: {
          fireworks: {
            adapter: "fireworks",
            baseUrl: "https://api.fireworks.ai/inference",
            credential: "{env:FIREWORKS_API_KEY}",
          },
        },
        routes: [{ id: "hijack", match: "*", upstream: "fireworks", model: "accounts/fireworks/models/x" }],
      }),
    ),
    secrets: createEnvResolver({ FIREWORKS_API_KEY: "fw_serverheldkey" }),
    resolveIdentity: (raw) => (raw === FEST ? { tokenId: "tok-1", userId: "user-1" } : null),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, () => sink.recent(50));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
  }
}

/** What `fest codex` makes Codex send on a ChatGPT login. */
const postChatgpt = (base: string): Promise<Response> =>
  fetch(`${base}/chatgpt/backend-api/codex/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${CHATGPT_JWT}`,
      "chatgpt-account-id": ACCOUNT,
      "x-fest-token": FEST,
      "x-fest-client": "codex",
      originator: "codex_exec",
      "session-id": SESSION,
      "x-codex-turn-state": "gAAAAABprevious",
      accept: "text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
  });

const postOpenai = (base: string): Promise<Response> =>
  fetch(`${base}/openai/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${OPENAI_KEY}`,
      "x-fest-token": FEST,
      originator: "codex_cli_rs",
      "session-id": SESSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true, input: [] }),
  });

// ── the mounts ───────────────────────────────────────────────────────────────

test("the mounts split on a segment boundary, and nowhere else", () => {
  assert.equal(splitMount("/openai", "/openai/v1/responses"), "/v1/responses");
  assert.equal(splitMount("/chatgpt", "/chatgpt/backend-api/codex/responses"), "/backend-api/codex/responses");
  assert.equal(splitMount("/openai", "/openaiish/v1/responses"), null);
  assert.equal(splitMount("/openai", "/v1/messages"), null);
});

// ── ChatGPT login ────────────────────────────────────────────────────────────

test("a ChatGPT request reaches chatgpt.com's path with the login and account intact", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base) => {
      await (await postChatgpt(base)).text();
      const seen = up.seen[0];
      assert.ok(seen !== undefined);
      assert.equal(seen.path, "/backend-api/codex/responses");
      assert.equal(seen.headers["authorization"], `Bearer ${CHATGPT_JWT}`);
      assert.equal(seen.headers["chatgpt-account-id"], ACCOUNT);
      assert.equal(seen.headers["x-codex-turn-state"], "gAAAAABprevious", "turn state travels up");
      assert.equal(seen.headers["x-fest-token"], undefined, "identity never leaves Fest");
      assert.equal(seen.headers["x-fest-client"], undefined);
      assert.equal(seen.headers["anthropic-version"], undefined, "no Anthropic header on an OpenAI wire");
    });
  } finally {
    await up.close();
  }
});

test("Codex gets an SSE stream it can read, and the headers it needs back", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base) => {
      const res = await postChatgpt(base);
      // Upstream sent no content-type; JSON would be a lie about a stream.
      assert.equal(res.headers.get("content-type"), "text/event-stream");
      assert.equal(res.headers.get("x-codex-turn-state"), "gAAAAABturnstate");
      assert.equal(res.headers.get("x-codex-primary-used-percent"), "4");
      assert.equal(res.headers.get("set-cookie"), null, "upstream cookies never reach the client");
      assert.equal(await res.text(), CODEX_STREAM, "the stream is relayed byte-for-byte");
    });
  } finally {
    await up.close();
  }
});

test("a ChatGPT turn is recorded as the developer's plan paying, with value and quota", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base, records) => {
      await (await postChatgpt(base)).text();
      const rec = records().at(-1);
      assert.ok(rec !== undefined, "the request was metered");
      assert.equal(rec.client, "codex");
      assert.equal(rec.sessionId, SESSION);
      assert.equal(rec.userId, "user-1");
      assert.equal(rec.posture, "subscription");
      assert.equal(rec.credentialOrigin, "inbound_subscription");
      assert.equal(rec.costBasis, "subscription");
      assert.equal(rec.costUsd, null, "a plan absorbed it: no org spend");
      assert.ok(rec.notionalCostUsd !== null && rec.notionalCostUsd > 0, "but the work has a list-rate value");
      assert.deepEqual({ ...rec.usage, serviceTier: undefined }, { ...EXPECTED, serviceTier: undefined });
      assert.equal(rec.rateLimit?.fiveHourUtilization, 0.04);
      assert.equal(rec.rateLimit?.sevenDayUtilization, 0.01);
      assert.equal(rec.rateLimit?.fiveHourResetAt, 1791895315);
      assert.equal(rec.rateLimit?.representativeClaim, "premium");

      const serialised = JSON.stringify(rec);
      assert.equal(serialised.includes(CHATGPT_JWT), false, "no credential at rest");
      assert.equal(serialised.includes(FEST), false);
    });
  } finally {
    await up.close();
  }
});

// ── API key ──────────────────────────────────────────────────────────────────

test("an API-key turn reaches /v1/responses and is priced as the key's spend", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base, records) => {
      await (await postOpenai(base)).text();
      assert.equal(up.seen[0]?.path, "/v1/responses");
      assert.equal(up.seen[0]?.headers["authorization"], `Bearer ${OPENAI_KEY}`);

      const rec = records().at(-1);
      assert.ok(rec !== undefined);
      assert.equal(rec.client, "codex", "detected from originator without the explicit label");
      assert.equal(rec.posture, "key");
      assert.equal(rec.credentialOrigin, "inbound_key");
      assert.equal(rec.costBasis, "list");
      assert.ok(rec.costUsd !== null && rec.costUsd > 0);
      assert.equal(rec.costUsd, rec.notionalCostUsd);
    });
  } finally {
    await up.close();
  }
});

test("the routing table gets no vote on a Codex mount", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base, records) => {
      await (await postOpenai(base)).text();
      assert.equal(up.seen.length, 1, "the caller's upstream was reached, not the route's");
      assert.equal(records().at(-1)?.pipeline, "passthrough");
      assert.equal(records().at(-1)?.routeId, null);
    });
  } finally {
    await up.close();
  }
});

// ── the rest of the mount ────────────────────────────────────────────────────

test("the model list is relayed with its etag, and is not metered", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base, records) => {
      const res = await fetch(`${base}/chatgpt/backend-api/codex/models?client_version=0.162.1`, {
        headers: { authorization: `Bearer ${CHATGPT_JWT}`, "if-none-match": 'W/"old"' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("etag"), 'W/"abc"');
      assert.equal(res.headers.get("x-models-etag"), 'W/"abc"');
      assert.deepEqual(await res.json(), { models: [{ slug: "gpt-6-astra" }] });
      assert.equal(up.seen[0]?.path, "/backend-api/codex/models?client_version=0.162.1");
      assert.equal(up.seen[0]?.headers["if-none-match"], 'W/"old"');
      assert.equal(records().length, 0);
    });
  } finally {
    await up.close();
  }
});

test("an unknown path under a mount is refused in OpenAI's envelope, not relayed", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base) => {
      const res = await fetch(`${base}/openai/v1/files`, { method: "POST", body: "{}" });
      assert.equal(res.status, 404);
      const body = (await res.json()) as { error?: { message?: string } };
      assert.match(body.error?.message ?? "", /not relayed/);
      assert.equal(up.seen.length, 0);
    });
  } finally {
    await up.close();
  }
});

test("a mount switched off refuses rather than falling through to Anthropic", async () => {
  const up = await mockUpstream();
  try {
    await withFest(
      up.url,
      async (base) => {
        const res = await postChatgpt(base);
        assert.equal(res.status, 501);
        assert.match(await res.text(), /FEST_CHATGPT_BASE_URL/);
        assert.equal(up.seen.length, 0);
      },
      { chatgptBaseUrl: null },
    );
  } finally {
    await up.close();
  }
});

test("a bad identity token is refused in OpenAI's envelope", async () => {
  const up = await mockUpstream();
  try {
    await withFest(up.url, async (base) => {
      const res = await fetch(`${base}/openai/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${OPENAI_KEY}`, "x-fest-token": "fest_revoked" },
        body: JSON.stringify({ model: "gpt-6-astra", stream: true }),
      });
      assert.equal(res.status, 401);
      const body = (await res.json()) as { error?: { message?: string; type?: string } };
      assert.equal(body.error?.type, "authentication_error");
      assert.equal(up.seen.length, 0);
    });
  } finally {
    await up.close();
  }
});

// ── how Codex ends a turn ────────────────────────────────────────────────────

/** An upstream that sends `body`, then holds the stream open, as chatgpt.com does. */
async function lingeringUpstream(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, {});
    res.write(body);
    open.add(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Read the stream until `marker` arrives, then hang up the way Codex does. */
async function readUntilThenHangUp(base: string, marker: string): Promise<void> {
  const abort = new AbortController();
  const res = await fetch(`${base}/chatgpt/backend-api/codex/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${CHATGPT_JWT}`, "x-fest-token": FEST },
    body: JSON.stringify({ model: "gpt-6-astra", stream: true }),
    signal: abort.signal,
  });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes(marker)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  abort.abort();
}

async function lastRecord(records: () => readonly UsageRecord[]): Promise<UsageRecord> {
  for (let i = 0; i < 100; i++) {
    const rec = records().at(-1);
    if (rec !== undefined) return rec;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no record");
}

test("hanging up after response.completed is a finished turn, not an abort", async () => {
  // The first live Codex turn through Fest was recorded as a failure exactly
  // this way: Codex stops reading at the terminal event, chatgpt.com had not
  // yet closed, and the disconnect read as the developer walking away.
  const up = await lingeringUpstream(CODEX_STREAM);
  try {
    await withFest(up.url, async (base, records) => {
      await readUntilThenHangUp(base, "response.completed");
      const rec = await lastRecord(records);
      assert.equal(rec.status, "ok");
      assert.equal(rec.partial, false);
      assert.equal(rec.usage.outputTokens, EXPECTED.outputTokens);
    });
  } finally {
    await up.close();
  }
});

test("hanging up before the terminal event is still an abort", async () => {
  const beforeEnd = CODEX_STREAM.slice(0, CODEX_STREAM.indexOf("event: response.completed"));
  const up = await lingeringUpstream(beforeEnd);
  try {
    await withFest(up.url, async (base, records) => {
      await readUntilThenHangUp(base, "response.output_text.done");
      const rec = await lastRecord(records);
      assert.equal(rec.status, "client_abort");
      assert.equal(rec.partial, true);
    });
  } finally {
    await up.close();
  }
});
