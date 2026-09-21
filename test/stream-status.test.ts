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
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": contentType });
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

async function recordFor(opts: {
  upstreamUrl: string;
  substitute: boolean;
}): Promise<import("../shared/types.ts").UsageRecord | undefined> {
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
    await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer sk-ant-oat01-SUBSCRIPTION", "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }),
    }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 60));
    return sink.recent(1)[0];
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
  }
}

test("pass-through: a 400 on a streaming request is recorded as an error, not ok", async () => {
  const up = await upstreamReturning(400, '{"error":{"message":"bad model"}}', "application/json");
  try {
    const rec = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.httpStatus, 400);
    assert.equal(rec?.status, "upstream_error", "an error rate that reads zero during an outage is the worst failure mode");
  } finally {
    await up.close();
  }
});

test("substitute: a 400 on a streaming request is recorded as an error, not ok", async () => {
  const up = await upstreamReturning(400, '{"error":{"message":"bad model"}}', "application/json");
  try {
    const rec = await recordFor({ upstreamUrl: up.url, substitute: true });
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
    const rec = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.status, "upstream_error");
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
    const rec = await recordFor({ upstreamUrl: up.url, substitute: false });
    assert.equal(rec?.status, "ok");
    assert.equal(rec?.usage.outputTokens, 9);
  } finally {
    await up.close();
  }
});
