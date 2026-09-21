/**
 * The substitute path against a real socket.
 *
 * The unit tests prove the decisions; this proves the WIRE. The assertion this
 * file exists for is the first one: a request routed to another provider must
 * not carry the developer's Anthropic bearer. That is a credential-disclosure
 * bug, and it is only observable by looking at what actually arrived.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../server/http/server.ts";
import { parseRouteTable } from "../server/routes/table.ts";
import { createEnvResolver } from "../server/credentials/provider.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BEARER = "sk-ant-oat01-DEVELOPERSOWNSUBSCRIPTIONBEARER";
const SERVER_KEY = "fw_serverheldproviderkey";

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A mock provider that records exactly what reached it. */
async function mockUpstream(
  respond: (res: http.ServerResponse) => void,
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      respond(res);
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

function sseResponse(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_read_input_tokens":5,"output_tokens":1}}}\n\n',
  );
  res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":42}}\n\n');
  res.end();
}

/**
 * Note the `/inference` prefix on the mock's base URL.
 *
 * Every mock here used to run at the server root, which made an entire class of
 * URL-joining bug invisible: `new URL("/v1/messages", base)` discards the
 * base's path, and with no path there was nothing to discard. The real
 * Fireworks endpoint has one. The prefix stays.
 */
const routesFor = (upstreamUrl: string): string =>
  JSON.stringify({
    upstreams: {
      fireworks: {
        adapter: "fireworks",
        baseUrl: `${upstreamUrl}/inference`,
        credential: "{env:FIREWORKS_API_KEY}",
      },
    },
    routes: [
      { id: "oss", match: "gpt-oss-*", upstream: "fireworks", model: "accounts/x/oss-120b" },
    ],
  });

async function withFest(
  opts: { routes: string; env: NodeJS.ProcessEnv },
  fn: (base: string, records: () => readonly import("../shared/types.ts").UsageRecord[]) => Promise<void>,
): Promise<void> {
  const sink = createUsageSink({ path: join(tmpdir(), `fest-sub-${Date.now()}.jsonl`) });
  const server = createServer({
    config: { ...loadConfig(), requireIdentity: false },
    sink,
    bus: createLiveBus(),
    orgId: "org-test",
    store: null as never,
    routes: parseRouteTable(opts.routes),
    secrets: createEnvResolver(opts.env),
    resolveIdentity: () => null,
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

const post = (base: string, model: string): Promise<Response> =>
  fetch(`${base}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${BEARER}`,
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, stream: true, max_tokens: 100, messages: [] }),
  });

test("a substituted request never carries the inbound Anthropic bearer", async () => {
  const upstream = await mockUpstream(sseResponse);
  try {
    await withFest(
      { routes: routesFor(upstream.url), env: { FIREWORKS_API_KEY: SERVER_KEY } },
      async (base) => {
        const res = await post(base, "gpt-oss-120b");
        await res.text();

        const seen = upstream.seen[0];
        assert.ok(seen !== undefined, "the provider received the request");

        // THE assertion. Forwarding a developer's personal Anthropic credential
        // to a third-party vendor is a credential disclosure, not a bug report.
        const all = JSON.stringify(seen.headers);
        assert.equal(all.includes(BEARER), false, "the inbound bearer must not reach the provider");
        assert.equal(all.includes("sk-ant"), false);
        assert.equal(seen.headers["anthropic-beta"], undefined, "Anthropic betas are not sent on");

        // The server-held credential is what authenticates, as a bearer.
        assert.equal(seen.headers["authorization"], `Bearer ${SERVER_KEY}`);
      },
    );
  } finally {
    await upstream.close();
  }
});

test("the model is rewritten and the request reaches the provider's path", async () => {
  const upstream = await mockUpstream(sseResponse);
  try {
    await withFest(
      { routes: routesFor(upstream.url), env: { FIREWORKS_API_KEY: SERVER_KEY } },
      async (base) => {
        await (await post(base, "gpt-oss-120b")).text();
        const seen = upstream.seen[0];
        assert.equal(JSON.parse(seen?.body ?? "{}").model, "accounts/x/oss-120b");
        // Phase 0: the query string is load-bearing and must survive routing.
        assert.match(
          seen?.path ?? "",
          /^\/inference\/v1\/messages\?beta=true$/,
          "the upstream's own path prefix must survive, and so must the query string",
        );
      },
    );
  } finally {
    await upstream.close();
  }
});

test("usage from a substituted stream is metered, and billed to the org", async () => {
  const upstream = await mockUpstream(sseResponse);
  try {
    await withFest(
      { routes: routesFor(upstream.url), env: { FIREWORKS_API_KEY: SERVER_KEY } },
      async (base, records) => {
        await (await post(base, "gpt-oss-120b")).text();
        await new Promise((r) => setTimeout(r, 50));

        const rec = records()[0];
        assert.ok(rec !== undefined, "a usage record was written");
        assert.equal(rec.pipeline, "substitute");
        assert.equal(rec.routeId, "oss");
        assert.equal(rec.requestedModel, "gpt-oss-120b");
        assert.equal(rec.servedModel, "accounts/x/oss-120b");

        // A server-held credential is org spend by definition, whatever the
        // caller presented. It must never be recorded as subscription-absorbed.
        assert.equal(rec.credentialOrigin, "fallback_server");
        assert.notEqual(rec.costBasis, "subscription");

        // output_tokens is cumulative: last wins, never summed.
        assert.equal(rec.usage.outputTokens, 42);
        assert.equal(rec.usage.inputTokens, 11);
        assert.equal(rec.usage.cacheReadTokens, 5);

        assert.deepEqual(
          rec.credentialsConsidered.map((c) => [c.source, c.result]),
          [
            ["inbound_subscription", "skipped"],
            ["env:FIREWORKS_API_KEY", "used"],
          ],
        );
      },
    );
  } finally {
    await upstream.close();
  }
});

test("a missing server credential refuses the request and never contacts the provider", async () => {
  const upstream = await mockUpstream(sseResponse);
  try {
    await withFest({ routes: routesFor(upstream.url), env: {} }, async (base, records) => {
      const res = await post(base, "gpt-oss-120b");
      assert.equal(res.status, 400);

      const body = (await res.json()) as { error: { message: string } };
      assert.match(body.error.message, /env:FIREWORKS_API_KEY/);
      assert.match(body.error.message, /not set on the Fest server/);

      assert.equal(upstream.seen.length, 0, "no request may be attempted without a credential");

      await new Promise((r) => setTimeout(r, 50));
      const rec = records()[0];
      assert.equal(rec?.status, "bad_request");
      assert.equal(
        rec?.credentialsConsidered.at(-1)?.result,
        "missing",
        "the refusal is recorded with its reason",
      );
    });
  } finally {
    await upstream.close();
  }
});

test("an unrouted model is untouched: verbatim body, bearer intact", async () => {
  const anthropic = await mockUpstream((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
  });
  const provider = await mockUpstream(sseResponse);
  try {
    process.env.FEST_UPSTREAM_BASE_URL = anthropic.url;
    await withFest(
      { routes: routesFor(provider.url), env: { FIREWORKS_API_KEY: SERVER_KEY } },
      async (base, records) => {
        const body = JSON.stringify({ model: "claude-opus-5", max_tokens: 1, messages: [] });
        await fetch(`${base}/v1/messages`, {
          method: "POST",
          headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" },
          body,
        });
        await new Promise((r) => setTimeout(r, 50));

        assert.equal(provider.seen.length, 0, "an unrouted model must not reach the provider");
        const seen = anthropic.seen[0];
        assert.equal(seen?.body, body, "the body must arrive byte-identical");
        assert.equal(seen?.headers["authorization"], `Bearer ${BEARER}`, "the bearer is relayed");

        const rec = records()[0];
        assert.equal(rec?.pipeline, "passthrough");
        assert.equal(rec?.routeId, null);
      },
    );
  } finally {
    delete process.env.FEST_UPSTREAM_BASE_URL;
    await anthropic.close();
    await provider.close();
  }
});
