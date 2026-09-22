/**
 * Claude in Amazon Bedrock, relayed on the developer's own AWS credential.
 *
 * Driven against a real socket because every property worth asserting here is
 * a wire property: which URL the request reached, which credential was on it,
 * and whether the routing table got a vote it should not have had.
 *
 * The mock deliberately lives under `/anthropic`, matching the real Bedrock
 * base URL. A mock at the server root would make the URL-joining bug this path
 * actually had invisible — `new URL("/v1/messages", base)` discards the base's
 * own path, and with no path there is nothing to discard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../server/http/server.ts";
import { splitBedrockMount } from "../server/pipeline/bedrock.ts";
import { parseRouteTable, EMPTY_ROUTE_TABLE } from "../server/routes/table.ts";
import type { RouteTable } from "../server/routes/table.ts";
import { createEnvResolver } from "../server/credentials/provider.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import type { UsageRecord } from "../shared/types.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** What the developer's client sends: an AWS bearer, not an Anthropic one. */
const AWS_BEARER = "ABSKQmVkcm9jay1zaG9ydC1saXZlZC1hd3MtYmVhcmVyLXRva2Vu";
const FEST = "fest_aWRlbnRpdHl0b2tlbmZvcmJlZHJvY2s";

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

async function mockBedrock(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
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
      // Bedrock's mantle endpoint speaks ordinary SSE, which is the whole
      // reason this path can be a byte relay.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1000,"output_tokens":1}}}\n\n',
      );
      res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500}}\n\n');
      res.end();
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
  opts: { bedrockBaseUrl: string | null; routes?: RouteTable },
  fn: (base: string, records: () => readonly UsageRecord[]) => Promise<void>,
): Promise<void> {
  const sink = createUsageSink({ path: join(tmpdir(), `fest-bedrock-${Date.now()}.jsonl`) });
  const server = createServer({
    config: {
      ...loadConfig(),
      requireIdentity: false,
      bedrockBaseUrl: opts.bedrockBaseUrl,
      // Anything that reaches Anthropic instead of Bedrock must fail loudly
      // rather than quietly succeed against the real API.
      upstreamBaseUrl: "http://127.0.0.1:1",
    },
    sink,
    bus: createLiveBus(),
    orgId: "org-test",
    store: null as never,
    routes: opts.routes ?? EMPTY_ROUTE_TABLE,
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

/** What Claude Code's mantle client sends once its base URL points at Fest. */
const postBedrock = (base: string, model: string): Promise<Response> =>
  fetch(`${base}/t/${FEST}/bedrock/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${AWS_BEARER}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, stream: true, max_tokens: 100, messages: [] }),
  });

// ── the mount ────────────────────────────────────────────────────────────────

test("the mount is split on a segment boundary, and nowhere else", () => {
  assert.equal(splitBedrockMount("/bedrock/v1/messages"), "/v1/messages");
  assert.equal(splitBedrockMount("/bedrock/v1/messages?beta=true"), "/v1/messages?beta=true");
  assert.equal(splitBedrockMount("/bedrock"), "/");
  // Everything downstream matches on a leading slash.
  assert.equal(splitBedrockMount("/bedrockish/v1/messages"), null);
  assert.equal(splitBedrockMount("/v1/messages"), null);
});

// ── the wire ─────────────────────────────────────────────────────────────────

test("a Bedrock request reaches the configured base URL, path prefix and query intact", async () => {
  const bedrock = await mockBedrock();
  try {
    await withFest({ bedrockBaseUrl: `${bedrock.url}/anthropic` }, async (base) => {
      const res = await postBedrock(base, "anthropic.claude-opus-5");
      assert.equal(res.status, 200);
      await res.text();

      const seen = bedrock.seen[0];
      assert.ok(seen !== undefined, "Bedrock received the request");
      // `/anthropic` is part of the real base URL, and `?beta=true` is
      // load-bearing per Phase 0. Both survive the mount.
      assert.equal(seen.path, "/anthropic/v1/messages?beta=true");
    });
  } finally {
    await bedrock.close();
  }
});

test("the developer's AWS bearer is forwarded verbatim and never recorded", async () => {
  const bedrock = await mockBedrock();
  try {
    await withFest({ bedrockBaseUrl: `${bedrock.url}/anthropic` }, async (base, records) => {
      await (await postBedrock(base, "anthropic.claude-opus-5")).text();

      const seen = bedrock.seen[0];
      // Forward and forget, exactly as on the subscription path: Fest holds no
      // Bedrock credential, so there is none to substitute or to store.
      assert.equal(seen?.headers["authorization"], `Bearer ${AWS_BEARER}`);

      const rec = records().at(-1);
      assert.ok(rec !== undefined, "the request was metered");
      assert.equal(rec.pipeline, "passthrough");
      // The caller's own key paid — not a subscription, and not a server-held
      // key. Reporting it as either would misstate who owes the money.
      assert.equal(rec.credentialOrigin, "inbound_key");
      assert.equal(rec.userId, "user-1", "attribution still comes from the /t/ prefix");

      const serialised = JSON.stringify(rec);
      assert.equal(serialised.includes(AWS_BEARER), false, "no credential at rest");
      assert.equal(serialised.includes(FEST), false, "not the identity token either");
    });
  } finally {
    await bedrock.close();
  }
});

test("a Bedrock-only model id is still priced, not left as n/a", async () => {
  const bedrock = await mockBedrock();
  try {
    await withFest({ bedrockBaseUrl: `${bedrock.url}/anthropic` }, async (base, records) => {
      // litellm files this one ONLY as `bedrock_mantle/anthropic.claude-haiku-4-5`,
      // so it is the id that proves the provider hint is being passed. Without
      // it the row meters tokens and shows no spend.
      await (await postBedrock(base, "anthropic.claude-haiku-4-5")).text();

      const rec = records().at(-1);
      assert.ok(rec !== undefined);
      assert.equal(rec.usage.outputTokens, 500, "usage was teed off the stream");
      assert.equal(rec.costBasis, "list", "the org pays AWS for this, so it is real spend");
      assert.ok((rec.costUsd ?? 0) > 0, `expected a dollar figure, got ${rec.costUsd}`);
    });
  } finally {
    await bedrock.close();
  }
});

test("the routing table gets no vote on the Bedrock mount", async () => {
  const bedrock = await mockBedrock();
  try {
    await withFest(
      {
        bedrockBaseUrl: `${bedrock.url}/anthropic`,
        // A rule that claims exactly the id the client is about to send. If the
        // mount went through the dispatcher, this would substitute a
        // server-held Fireworks key for the developer's AWS bearer — the silent
        // credential swap this codebase exists to make impossible.
        routes: parseRouteTable(
          JSON.stringify({
            upstreams: {
              fireworks: {
                adapter: "fireworks",
                baseUrl: "https://api.fireworks.ai/inference",
                credential: "{env:FIREWORKS_API_KEY}",
              },
            },
            routes: [
              {
                id: "hijack",
                match: "anthropic.claude-*",
                upstream: "fireworks",
                model: "accounts/x/something-else",
              },
            ],
          }),
        ),
      },
      async (base, records) => {
        await (await postBedrock(base, "anthropic.claude-opus-5")).text();

        assert.equal(bedrock.seen.length, 1, "the request went to Bedrock, not to Fireworks");
        assert.equal(bedrock.seen[0]?.headers["authorization"], `Bearer ${AWS_BEARER}`);

        const rec = records().at(-1);
        assert.equal(rec?.pipeline, "passthrough");
        assert.equal(rec?.routeId, null, "no route was consulted, so none is recorded");
      },
    );
  } finally {
    await bedrock.close();
  }
});

test("the mount refuses rather than falling through when no Bedrock upstream is set", async () => {
  await withFest({ bedrockBaseUrl: null }, async (base) => {
    const res = await postBedrock(base, "anthropic.claude-opus-5");
    // Falling through would send an AWS bearer to api.anthropic.com and hand
    // the developer a 401 that says nothing about the real mistake.
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /FEST_BEDROCK_BASE_URL/);
  });
});
