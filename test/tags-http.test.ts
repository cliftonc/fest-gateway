/**
 * Request tags, end to end: declared on the path and/or `x-fest-tags`, carried
 * through a real server into the real writer, and invisible upstream.
 *
 * The path form is the risky half. A `~…` segment that survived into the
 * upstream URL would 404 every request from a tagged client, and one that
 * survived only on the Copilot mount would break Copilot alone — which is
 * exactly the client that cannot use the header form.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/http/server.ts";
import { createUsageSink } from "../server/ingest/sink.ts";
import { createLiveBus } from "../server/ingest/live-bus.ts";
import { loadConfig } from "../server/config.ts";
import { openStore, migrate } from "../server/store/db.ts";
import { createRequestWriter } from "../server/store/write.ts";
import { ensureOrg, ensureUser } from "../server/store/bootstrap.ts";
import { createToken, resolveToken } from "../server/store/tokens.ts";
import { listRequests, tagValues, usageByTag, usageTotals } from "../server/store/queries.ts";

interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
}

async function echoUpstream(): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          type: "message",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "pong" }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
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

test("tags from the path and the header are recorded and never reach upstream", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fest-tags-"));
  const upstream = await echoUpstream();
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
      requireIdentity: false,
      upstreamBaseUrl: upstream.url,
      copilotBaseUrl: `${upstream.url}/{plan}`,
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
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await sink.close();
    await upstream.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const body = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [] });
  const post = async (path: string, headers: Record<string, string>): Promise<number> => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
    await res.text();
    return res.status;
  };

  // Claude Code, subscription posture: token and tags on the path, plus a
  // header that the path overrides on `project`.
  assert.equal(
    await post(`/t/${fest}/~team=platform,project=fest/v1/messages?beta=true`, {
      authorization: "Bearer sk-ant-oat01-SUBSCRIPTION",
      "x-fest-tags": "project=other,env=dev",
    }),
    200,
  );
  // Key posture, no identity prefix: the tag segment comes first.
  assert.equal(
    await post(`/~project=website/v1/messages`, { "x-api-key": "sk-ant-api03-KEY" }),
    200,
  );
  // Copilot on its own login: the tag segment sits between token and mount.
  assert.equal(
    await post(`/t/${fest}/~project=fest/copilot/individual/v1/messages`, {
      authorization: "Bearer gho_Q7xYv2KpL9mN4rT8wZ3bC6dF1gH5jS0aE2uI",
      "copilot-integration-id": "copilot-developer-cli",
    }),
    200,
  );
  // Header only, with a value that has to be URL-decoded.
  assert.equal(
    await post(`/v1/messages`, {
      "x-api-key": "sk-ant-api03-KEY",
      "x-fest-tags": "team=Platform%20team",
    }),
    200,
  );

  await new Promise((r) => setTimeout(r, 80));

  assert.deepEqual(
    upstream.seen.map((s) => s.path),
    ["/v1/messages?beta=true", "/v1/messages", "/individual/v1/messages", "/v1/messages"],
    "no ~ segment and no token may reach upstream",
  );
  for (const s of upstream.seen) {
    assert.equal(s.headers["x-fest-tags"], undefined, "x-fest-tags must be stripped");
  }

  const scope = { orgId: org.id, role: "admin" as const };
  const rows = listRequests(store, scope, { limit: 10 }).rows.reverse();
  assert.deepEqual(
    rows.map((r) => r.tags),
    [
      { env: "dev", project: "fest", team: "platform" },
      { project: "website" },
      { project: "fest" },
      { team: "Platform team" },
    ],
  );

  // And the rollup agrees with the raw rows, so long ranges filter the same.
  const now = Date.now();
  const short = { fromMs: now - 3_600_000, toMs: now + 1 };
  const long = { fromMs: now - 7 * 86_400_000, toMs: now + 1 };
  for (const range of [short, long]) {
    const byProject = usageByTag(store, scope, range, "project");
    assert.deepEqual(
      byProject.map((r) => [r.value, r.requests]),
      [
        ["fest", 2],
        ["website", 1],
        ["", 1],
      ],
    );
    assert.equal(usageTotals(store, scope, { ...range, tags: { project: "fest" } }).requests, 2);
    assert.equal(
      usageTotals(store, scope, { ...range, tags: { project: "fest", team: "platform" } }).requests,
      1,
    );
    const keys = tagValues(store, scope, range);
    assert.deepEqual(
      keys.find((k) => k.key === "team")?.values,
      [
        { value: "platform", requests: 1 },
        { value: "Platform team", requests: 1 },
      ],
    );
  }
});
