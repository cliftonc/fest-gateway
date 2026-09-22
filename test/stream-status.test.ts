/**
 * A streaming response that fails BEFORE emitting any events.
 *
 * Found by running a real request through a real provider: a 400 arrived,
 * the body streamed cleanly, and the record said `status: "ok"`. Both pipelines
 * derived status only from client aborts and in-band SSE `error` events, so an
 * upstream that refuses up front produced a tidy, successful-looking row.
 *
 * The consequence is the worst kind of monitoring failure: the dashboard's
 * error rate reads as zero at exactly the moment a provider is rejecting
 * everything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import { parseRouteTable, EMPTY_ROUTE_TABLE } from "../server/routes/table.ts";
import { createEnvResolver } from "../server/credentials/provider.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function upstreamReturning(
  status: number,
  body: string,
  contentType: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": contentType, ...extraHeaders });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

interface Exchange {
  readonly rec: import("../shared/types.ts").UsageRecord | undefined;
  /** What Claude Code actually received, so relay and record can be compared. */
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
}

async function recordFor(opts: {
  upstreamUrl: string;
  substitute: boolean;
  /** Overrides the default streaming turn — used for the warmup ping's shape. */
  requestBody?: Record<string, unknown>;
}): Promise<Exchange> {
  const sink = createUsageSink({ path: join(tmpdir(), `fest-status-${Date.now()}.jsonl`) });
  const routes = opts.substitute
    ? parseRouteTable(
        JSON.stringify({
          upstreams: {
            p: { adapter: "fireworks", baseUrl: opts.upstreamUrl, credential: "{env:K}" },
          },
          routes: [{ id: "r", match: "claude-sonnet-5", upstream: "p" }],
        }),
      )
    : EMPTY_ROUTE_TABLE;

  const server = createServer({
    config: { ...loadConfig(), upstreamBaseUrl: opts.upstreamUrl, requireIdentity: false },
    sink,
    bus: createLiveBus(),
    orgId: "org",
    store: null as never,
    routes,
    secrets: createEnvResolver({ K: "server-held-key" }),
    resolveIdentity: () => null,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer sk-ant-oat01-SUBSCRIPTION", "content-type": "application/json" },
      body: JSON.stringify(
        opts.requestBody ?? { model: "claude-sonnet-5", stream: true, messages: [] },
      ),
    });
    const body = await res.text();
    await new Promise((r) => setTimeout(r, 60));
    return {
      rec: sink.recent(1)[0],
      status: res.status,
      body,
      contentType: res.headers.get("content-type"),
    };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
  }
}

test("pass-through: a 400 on a streaming request is recorded as an error, not ok", async () => {
  const up = await upstreamReturning(400, '{"error":{"message":"bad model"}}', "application/json");
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.httpStatus, 400);
    assert.equal(rec?.status, "upstream_error", "an error rate that reads zero during an outage is the worst failure mode");
  } finally {
    await up.close();
  }
});

test("substitute: a 400 on a streaming request is recorded as an error, not ok", async () => {
  const up = await upstreamReturning(400, '{"error":{"message":"bad model"}}', "application/json");
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: true });
    assert.equal(rec?.httpStatus, 400);
    assert.equal(rec?.status, "upstream_error");
    assert.equal(rec?.pipeline, "substitute");
  } finally {
    await up.close();
  }
});

test("a 429 is an error too — it is the one an operator most needs to see", async () => {
  const up = await upstreamReturning(429, '{"error":{"message":"slow down"}}', "application/json");
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.status, "upstream_error");
  } finally {
    await up.close();
  }
});

/**
 * Recording the status alone was not enough.
 *
 * The provider's own explanation — "which field did it object to" — was relayed
 * to the developer's terminal and then dropped on the floor, so every 4xx in the
 * database had a null `error_type` and `error_message`. Diagnosing a 400 meant
 * asking a developer to reproduce it and read their screen back.
 */
test("the provider's reason is captured, not just its status", async () => {
  const up = await upstreamReturning(
    400,
    JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "context_management.edits.0: Extra inputs are not permitted",
      },
    }),
    "application/json",
  );
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.errorType, "invalid_request_error");
    assert.equal(rec?.errorMessage, "context_management.edits.0: Extra inputs are not permitted");
  } finally {
    await up.close();
  }
});

test("substitute captures it too — a third-party provider's rules are its own", async () => {
  const up = await upstreamReturning(
    400,
    JSON.stringify({ error: { code: "invalid_body", message: "unknown field: safeguards" } }),
    "application/json",
  );
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: true });
    assert.equal(rec?.errorType, "invalid_body");
    assert.equal(rec?.errorMessage, "unknown field: safeguards");
  } finally {
    await up.close();
  }
});

/**
 * Capturing the body must not change what the client receives. Buffering an
 * error rather than teeing it is an internal decision; the developer's client
 * still has to see the same bytes and the same status it would have seen
 * talking to the provider directly.
 */
test("the error body still reaches the client byte-for-byte", async () => {
  const raw = '{"error":{"type":"invalid_request_error","message":"bad model"}}';
  const up = await upstreamReturning(400, raw, "application/json");
  try {
    const { status, body, contentType } = await recordFor({
      upstreamUrl: up.url,
      substitute: false,
    });
    assert.equal(status, 400);
    assert.equal(body, raw);
    // Not `text/event-stream`: the client asked for a stream and is getting a
    // JSON error, and telling it otherwise makes it wait for events that never come.
    assert.match(contentType ?? "", /application\/json/);
  } finally {
    await up.close();
  }
});

test("a non-JSON error body is still recorded, because a gateway's HTML is a clue too", async () => {
  const up = await upstreamReturning(502, "<html><body>Bad Gateway</body></html>", "text/html");
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.status, "upstream_error");
    assert.equal(rec?.errorType, "api_error");
    assert.match(rec?.errorMessage ?? "", /Bad Gateway/);
  } finally {
    await up.close();
  }
});

// ── the session-start warmup ping ─────────────────────────────────────────────

/** Claude Code's actual preflight: one token, no system, no tools, no stream. */
const WARMUP_PING = {
  model: "claude-opus-5",
  max_tokens: 1,
  messages: [{ role: "user", content: "hi" }],
};

const REFUSAL_BODY = '{"type":"error","error":{"type":"rate_limit_error","message":"Error"}}';

test("the warmup refusal is recorded, but not as a failure", async () => {
  // No quota headers — that is what makes it a shape rejection, not a limit.
  const up = await upstreamReturning(429, REFUSAL_BODY, "application/json");
  try {
    const { rec } = await recordFor({
      upstreamUrl: up.url,
      substitute: false,
      requestBody: WARMUP_PING,
    });
    assert.equal(rec?.status, "preflight_refused");
    assert.equal(rec?.httpStatus, 429, "the row still carries what actually happened");
    assert.equal(rec?.errorType, "rate_limit_error");
    assert.equal(rec?.errorMessage, "Error");
  } finally {
    await up.close();
  }
});

/**
 * The test that matters most in this file. Reclassifying the warmup refusal is
 * only defensible if a developer who really has hit the wall still sees it.
 */
test("the SAME ping with quota headers is a real error and stays one", async () => {
  const up = await upstreamReturning(429, REFUSAL_BODY, "application/json", {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-5h-utilization": "1.0",
    "anthropic-ratelimit-unified-5h-status": "rejected",
  });
  try {
    const { rec } = await recordFor({
      upstreamUrl: up.url,
      substitute: false,
      requestBody: WARMUP_PING,
    });
    assert.equal(rec?.status, "upstream_error", "a real quota wall must never be quiet");
    assert.equal(rec?.rateLimit?.fiveHourStatus, "rejected");
  } finally {
    await up.close();
  }
});

test("the client still receives the 429 unchanged — we reclassify our record, not their response", async () => {
  const up = await upstreamReturning(429, REFUSAL_BODY, "application/json");
  try {
    const { status, body } = await recordFor({
      upstreamUrl: up.url,
      substitute: false,
      requestBody: WARMUP_PING,
    });
    assert.equal(status, 429);
    assert.equal(body, REFUSAL_BODY);
  } finally {
    await up.close();
  }
});

test("a clean 200 stream is still ok", async () => {
  const up = await upstreamReturning(
    200,
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":1}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n',
    "text/event-stream",
  );
  try {
    const { rec } = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.status, "ok");
    assert.equal(rec?.usage.outputTokens, 9);
  } finally {
    await up.close();
  }
});
