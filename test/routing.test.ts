/**
 * Routing config and resolution.
 *
 * Config validation is strict because the failure mode of a lenient parser is
 * silent: a route that does not apply sends traffic to Anthropic on a
 * developer's subscription while the operator believes it is going elsewhere,
 * and nothing anywhere reports it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRouteTable, RouteConfigError, EMPTY_ROUTE_TABLE } from "../server/routes/table.ts";
import { resolveRoute } from "../server/routes/resolve.ts";

const UPSTREAM = {
  fireworks: {
    adapter: "fireworks",
    baseUrl: "https://api.fireworks.ai/inference",
    credential: "{env:FIREWORKS_API_KEY}",
  },
};

const config = (routes: unknown[], upstreams: unknown = UPSTREAM): string =>
  JSON.stringify({ upstreams, routes });

function problems(text: string): string[] {
  try {
    parseRouteTable(text);
    return [];
  } catch (err) {
    assert.ok(err instanceof RouteConfigError, `expected RouteConfigError, got ${err}`);
    return err.message.split("\n").filter((l) => l.startsWith("  - "));
  }
}

// ── validation ────────────────────────────────────────────────────────────────

test("a valid table parses and carries a content version", () => {
  const table = parseRouteTable(
    config([{ id: "oss", match: "gpt-oss-120b", upstream: "fireworks", model: "accounts/x/y" }]),
  );
  assert.equal(table.routes.length, 1);
  assert.equal(table.upstreams.get("fireworks")?.credential.source, "env:FIREWORKS_API_KEY");
  assert.match(table.version, /^[0-9a-f]+$/);
});

test("the version changes with content and is stable for identical content", () => {
  const a = config([{ id: "r", match: "m", upstream: "fireworks" }]);
  const b = config([{ id: "r", match: "other", upstream: "fireworks" }]);
  assert.equal(parseRouteTable(a).version, parseRouteTable(a).version);
  assert.notEqual(parseRouteTable(a).version, parseRouteTable(b).version);
});

test("a literal credential is rejected with advice, not a parse error", () => {
  const found = problems(
    config([{ id: "r", match: "m", upstream: "fireworks" }], {
      fireworks: {
        adapter: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference",
        credential: "fw_averyrealsecret",
      },
    }),
  );
  assert.equal(found.length, 1);
  // Pasting the key is the common mistake; the message has to name the fix, or
  // the next thing tried is different quoting and the secret lands in git.
  assert.match(found[0] ?? "", /environment variable/);
});

test("an unknown upstream is named rather than ignored", () => {
  const found = problems(config([{ id: "r", match: "m", upstream: "typo" }]));
  assert.match(found[0] ?? "", /unknown upstream "typo"/);
  assert.match(found[0] ?? "", /Known: fireworks/);
});

test("an unknown adapter is rejected", () => {
  const found = problems(
    config([{ id: "r", match: "m", upstream: "x" }], {
      x: { adapter: "openai", baseUrl: "https://x.test", credential: "{env:K}" },
    }),
  );
  assert.ok(found.some((p) => /adapter must be one of/.test(p)));
});

test("a plaintext http upstream is rejected, but loopback is allowed for tests", () => {
  assert.ok(
    problems(
      config([{ id: "r", match: "m", upstream: "x" }], {
        x: { adapter: "fireworks", baseUrl: "http://provider.test", credential: "{env:K}" },
      }),
    ).some((p) => /must be https/.test(p)),
    "a server-held credential must not cross the network in plaintext",
  );
  assert.doesNotThrow(() =>
    parseRouteTable(
      config([{ id: "r", match: "m", upstream: "x" }], {
        x: { adapter: "fireworks", baseUrl: "http://127.0.0.1:9/x", credential: "{env:K}" },
      }),
    ),
  );
});

test("an upstream nothing routes to is an error, not dead config", () => {
  assert.ok(
    problems(config([])).some((p) => /no route targets it/.test(p)),
    "an operator believing traffic goes somewhere it does not is the whole failure mode",
  );
});

test("duplicate route ids are rejected", () => {
  const found = problems(
    config([
      { id: "dup", match: "a", upstream: "fireworks" },
      { id: "dup", match: "b", upstream: "fireworks" },
    ]),
  );
  assert.ok(found.some((p) => /duplicate route id/.test(p)));
});

test("a mid-pattern wildcard is rejected rather than silently treated as literal", () => {
  const found = problems(config([{ id: "r", match: "claude-*-5", upstream: "fireworks" }]));
  assert.ok(found.some((p) => /trailing wildcard/.test(p)));
});

test("every problem is reported, not just the first", () => {
  const found = problems(
    config([
      { id: "a", match: "x", upstream: "nope" },
      { match: "y", upstream: "fireworks" },
    ]),
  );
  assert.ok(found.length >= 2, `expected several problems, got ${found.length}`);
});

test("malformed JSON fails with a readable message", () => {
  assert.throws(() => parseRouteTable("{nope"), RouteConfigError);
});

// ── resolution ────────────────────────────────────────────────────────────────

const table = parseRouteTable(
  config([
    { id: "exception", match: "claude-opus-5", upstream: null },
    { id: "broad", match: "claude-*", upstream: "fireworks", model: "accounts/x/claude-ish" },
    { id: "specific", match: "claude-haiku-*", upstream: "fireworks", model: "accounts/x/haiku" },
  ]),
);

test("an exact rule beats a wildcard wherever it sits in the file", () => {
  // `exception` is first here, but the rule must hold regardless of order —
  // that is the entire point of preferring exactness.
  const d = resolveRoute(table, "claude-opus-5");
  assert.equal(d.route?.id, "exception");
  assert.equal(d.pipeline, "passthrough", "a null upstream keeps it on the subscription");
});

test("a longer wildcard beats a shorter one", () => {
  const d = resolveRoute(table, "claude-haiku-4-5");
  assert.equal(d.route?.id, "specific");
  assert.equal(d.servedModel, "accounts/x/haiku");
});

test("a broad wildcard catches the rest and rewrites the model", () => {
  const d = resolveRoute(table, "claude-sonnet-5");
  assert.equal(d.route?.id, "broad");
  assert.equal(d.pipeline, "substitute");
  assert.equal(d.requestedModel, "claude-sonnet-5");
  assert.equal(d.servedModel, "accounts/x/claude-ish");
  assert.equal(d.upstream?.id, "fireworks");
});

test("an unmatched model passes through unchanged", () => {
  const d = resolveRoute(table, "gpt-5");
  assert.equal(d.route, null);
  assert.equal(d.pipeline, "passthrough");
  assert.equal(d.servedModel, "gpt-5");
});

test("a request with no readable model is never routed", () => {
  // Routing a request we could not identify is how traffic reaches a provider
  // nobody chose.
  for (const model of [null, ""]) {
    const d = resolveRoute(table, model);
    assert.equal(d.pipeline, "passthrough");
    assert.equal(d.route, null);
  }
});

test("an empty table passes everything through", () => {
  const d = resolveRoute(EMPTY_ROUTE_TABLE, "anything");
  assert.equal(d.pipeline, "passthrough");
  assert.equal(d.route, null);
});

test("a route without an explicit model keeps the requested id", () => {
  const t = parseRouteTable(config([{ id: "keep", match: "m", upstream: "fireworks" }]));
  assert.equal(resolveRoute(t, "m").servedModel, "m");
});

// ── what the dashboard is allowed to see ──────────────────────────────────────

test("evaluation order is what the dashboard shows, not file order", async () => {
  const { evaluationOrder } = await import("../server/routes/resolve.ts");
  const t = parseRouteTable(
    config([
      { id: "broad", match: "claude-*", upstream: "fireworks" },
      { id: "specific", match: "claude-haiku-*", upstream: "fireworks" },
      { id: "exact", match: "claude-opus-5", upstream: null },
    ]),
  );
  // Showing an operator the file would be showing them something subtly
  // untrue: the file's order is not the order rules are applied in.
  assert.deepEqual(
    evaluationOrder(t).map((r) => r.id),
    ["exact", "specific", "broad"],
  );
});

test("the routing API exposes references and status, never a value", async () => {
  const { handleApi } = await import("../server/api/routes.ts");
  const { createEnvResolver } = await import("../server/credentials/provider.ts");
  const SECRET = "fw_thisistheactualsecret";

  let payload = "";
  const res = {
    writeHead() {},
    end(body: string) {
      payload = body;
    },
  };

  handleApi(
    { method: "GET", url: "/api/routing", headers: {} } as never,
    res as never,
    "/api/routing",
    {
      store: null as never,
      sink: null as never,
      bus: null as never,
      scope: { orgId: "org", role: "admin" },
      routes: parseRouteTable(config([{ id: "r", match: "m", upstream: "fireworks" }])),
      secrets: createEnvResolver({ FIREWORKS_API_KEY: SECRET }),
    },
  );

  assert.equal(payload.includes(SECRET), false, "a configured secret must never be serialised");
  assert.equal(payload.includes("fw_"), false, "not even a prefix");

  const parsed = JSON.parse(payload) as {
    upstreams: Array<{ credentialSource: string; credentialPresent: boolean }>;
  };
  assert.equal(parsed.upstreams[0]?.credentialSource, "env:FIREWORKS_API_KEY");
  assert.equal(parsed.upstreams[0]?.credentialPresent, true, "status is useful and discloses nothing");
});

test("an unset credential is reported as absent rather than omitted", async () => {
  const { handleApi } = await import("../server/api/routes.ts");
  const { createEnvResolver } = await import("../server/credentials/provider.ts");

  let payload = "";
  handleApi(
    { method: "GET", url: "/api/routing", headers: {} } as never,
    { writeHead() {}, end: (b: string) => void (payload = b) } as never,
    "/api/routing",
    {
      store: null as never,
      sink: null as never,
      bus: null as never,
      scope: { orgId: "org", role: "admin" },
      routes: parseRouteTable(config([{ id: "r", match: "m", upstream: "fireworks" }])),
      secrets: createEnvResolver({}),
    },
  );
  // A route that will refuse every request it matches must be visible BEFORE a
  // developer discovers it mid-task.
  assert.equal(JSON.parse(payload).upstreams[0].credentialPresent, false);
});
