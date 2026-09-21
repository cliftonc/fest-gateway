/**
 * Key posture: identity in `ANTHROPIC_AUTH_TOKEN`, and the model menu it buys.
 *
 * The rule under test everywhere here: a Fest token is IDENTITY wherever it
 * arrives. Relaying our own bearer upstream would authenticate nothing and
 * disclose a credential that can impersonate a developer on this gateway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectInbound } from "../server/auth/posture.ts";
import { buildModelMenu } from "../server/api/models.ts";
import { parseRouteTable, EMPTY_ROUTE_TABLE } from "../server/routes/table.ts";
import { noIdentity, badIdentity, noUpstreamCredential } from "../server/auth/gateway-401.ts";

const FEST = "fest_aGVsbG8gdGhlcmUgZnJpZW5kcw";
const OAUTH = "sk-ant-oat01-DEVELOPERSUBSCRIPTIONBEARER";
const APIKEY = "sk-ant-api03-ANORGAPIKEYVALUE";

// ── a Fest token is identity, wherever it arrives ─────────────────────────────

test("a Fest token in Authorization is identity, not an upstream credential", () => {
  const inbound = detectInbound("/v1/messages", { authorization: `Bearer ${FEST}` });
  assert.equal(inbound.identityToken, FEST);
  assert.equal(inbound.identity.carrier, "auth_header");
  assert.equal(
    inbound.upstreamCredential,
    null,
    "forwarding our own bearer would disclose a credential that impersonates a developer here",
  );
  assert.equal(inbound.posture, "key");
});

test("a Fest token in x-api-key is treated the same way", () => {
  const inbound = detectInbound("/v1/messages", { "x-api-key": FEST });
  assert.equal(inbound.identityToken, FEST);
  assert.equal(inbound.identity.carrier, "auth_header");
  assert.equal(inbound.upstreamCredential, null);
});

test("a subscription bearer is untouched — the pass-through path is unchanged", () => {
  const inbound = detectInbound("/v1/messages", { authorization: `Bearer ${OAUTH}` });
  assert.equal(inbound.posture, "subscription");
  assert.equal(inbound.upstreamCredential?.kind, "ANTHROPIC_OAUTH_SUBSCRIPTION");
  assert.equal(inbound.identity.carrier, "none");
});

test("a real provider key alongside a Fest token: the key is forwarded, the token is not", () => {
  const inbound = detectInbound("/v1/messages", {
    authorization: `Bearer ${FEST}`,
    "x-api-key": APIKEY,
  });
  assert.equal(inbound.identityToken, FEST);
  assert.equal(inbound.upstreamCredential?.kind, "ANTHROPIC_API_KEY");
});

test("the path form still wins over the auth header", () => {
  // The path is what we hand developers, so it is the deliberate one. The auth
  // header is last because it is the only position a token reaches by accident.
  const inbound = detectInbound(`/t/${FEST}/v1/messages`, {
    authorization: "Bearer fest_someothertokenvaluehere",
  });
  assert.equal(inbound.identityToken, FEST);
  assert.equal(inbound.identity.carrier, "path");
});

test("X-Fest-Token beats the auth header but loses to the path", () => {
  const header = detectInbound("/v1/messages", {
    "x-fest-token": FEST,
    authorization: "Bearer fest_lowerprecedencetoken",
  });
  assert.equal(header.identity.carrier, "header");
  assert.equal(header.identityToken, FEST);
});

test("the raw identity token never appears in what we record", () => {
  const inbound = detectInbound("/v1/messages", { authorization: `Bearer ${FEST}` });
  // `identityToken` is for authentication only; the fingerprint is what is kept.
  assert.notEqual(inbound.identity.tokenFingerprint, FEST);
  assert.equal(inbound.identity.tokenFingerprint?.length, 12);
});

// ── the model menu ────────────────────────────────────────────────────────────

const table = parseRouteTable(
  JSON.stringify({
    upstreams: {
      fireworks: {
        adapter: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference",
        credential: "{env:FIREWORKS_API_KEY}",
      },
    },
    routes: [
      { id: "sonnet", match: "claude-sonnet-5", upstream: "fireworks", model: "accounts/x/kimi" },
      { id: "wild", match: "claude-haiku-*", upstream: "fireworks", model: "accounts/x/fast" },
      { id: "keep", match: "claude-opus-5", upstream: null },
    ],
  }),
);

test("routes are published under the id the developer types, not the provider's", () => {
  // Claude Code filters ids by /(claude|anthropic)/i, so publishing
  // `accounts/x/kimi` would silently drop the entry from the menu entirely.
  const ids = buildModelMenu(table).map((m) => m.id);
  assert.ok(ids.includes("claude-sonnet-5"));
  assert.equal(
    ids.some((id) => id.startsWith("accounts/")),
    false,
    "a provider id would be filtered out client-side and the route would vanish from /model",
  );
});

test("a wildcard pattern is not published — it is not something anyone can type", () => {
  assert.equal(
    buildModelMenu(table).some((m) => m.id.includes("*")),
    false,
  );
});

test("a substituted model is labelled with where it actually goes", () => {
  const entry = buildModelMenu(table).find((m) => m.id === "claude-sonnet-5");
  assert.match(
    entry?.display_name ?? "",
    /fireworks/,
    "choosing 'Sonnet 5' and silently getting Kimi is the substitution this project exists to prevent",
  );
});

test("a WILDCARD route is reflected in the menu, via the real router", () => {
  // Found by running it: the common case is a wildcard route, and publishing
  // patterns alone produced a menu that showed no substitutions at all.
  // Concrete ids are resolved through resolveRoute, so the label and the actual
  // routing decision cannot disagree.
  const wild = parseRouteTable(
    JSON.stringify({
      upstreams: {
        fireworks: {
          adapter: "fireworks",
          baseUrl: "https://api.fireworks.ai/inference",
          credential: "{env:FIREWORKS_API_KEY}",
        },
      },
      routes: [
        { id: "s", match: "claude-sonnet-*", upstream: "fireworks", model: "accounts/x/kimi" },
        { id: "h", match: "claude-haiku-*", upstream: null },
      ],
    }),
  );
  const menu = buildModelMenu(wild);
  assert.match(menu.find((m) => m.id === "claude-sonnet-5")?.display_name ?? "", /fireworks/);
  // A route that deliberately keeps a model on the subscription is NOT servable
  // in the key posture, so it must not be offered at all.
  assert.equal(menu.find((m) => m.id === "claude-haiku-4-5-20251001"), undefined);
  assert.equal(menu.find((m) => m.id === "claude-opus-5"), undefined);
});

test("the menu offers ONLY models this gateway can actually serve", () => {
  // Found in use: the menu published Anthropic's built-ins unconditionally
  // "so routing never loses Opus", and selecting the resulting `Opus 5 — From
  // gateway` entry returned 401. Discovery only happens in the key posture,
  // where there is no caller credential to fall back on, so an id without a
  // route to a server-held credential is a guaranteed failure on selection.
  // A menu is a promise; it must only promise what it can keep.
  const ids = buildModelMenu(table).map((m) => m.id);
  assert.ok(ids.includes("claude-sonnet-5"), "routed to fireworks, so servable");
  assert.equal(ids.includes("claude-opus-5"), false, "route says pass-through: unservable in key posture");
  // haiku IS routed to fireworks by the `wild` rule in this fixture.
  assert.ok(ids.includes("claude-haiku-4-5-20251001"), "claude-haiku-* routes to fireworks");
});

test("with no routing config there is no menu at all", () => {
  // The client treats a 404 / empty menu as "no gateway models" and falls back
  // to its built-in list, which is the correct outcome — better than offering
  // entries that cannot be served.
  assert.deepEqual(buildModelMenu(EMPTY_ROUTE_TABLE), []);
});

test("every published entry resolves to a substitute route with an upstream", async () => {
  const { resolveRoute } = await import("../server/routes/resolve.ts");
  for (const entry of buildModelMenu(table)) {
    const d = resolveRoute(table, entry.id);
    assert.equal(d.pipeline, "substitute", `${entry.id} would 401 on selection`);
    assert.notEqual(d.upstream, null);
  }
});

test("every published id survives Claude Code's own filter", () => {
  for (const entry of buildModelMenu(table)) {
    assert.match(entry.id, /(claude|anthropic)/i, `${entry.id} would be dropped client-side`);
  }
});

test("ids are unique — a duplicate would render twice in the picker", () => {
  const ids = buildModelMenu(table).map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ── the 401s are UI ───────────────────────────────────────────────────────────

test("the no-identity message offers both postures and says which is better", () => {
  const m = noIdentity("https://fest.corp").message;
  assert.match(m, /ANTHROPIC_BASE_URL=https:\/\/fest\.corp\/t\/<your-token>/);
  assert.match(m, /ANTHROPIC_AUTH_TOKEN/);
  assert.match(m, /bills your own subscription/);
});

test("a bad token tells the developer it is the token, not their setup", () => {
  assert.match(badIdentity().message, /unknown, revoked, or expired/);
});


test("no 401 message ever tells a subscription user to set ANTHROPIC_AUTH_TOKEN unconditionally", () => {
  // That variable is exactly what disables their subscription, so it may only
  // ever appear as an explicitly labelled alternative.
  for (const failure of [noIdentity("https://x"), badIdentity(), noUpstreamCredential(null)]) {
    if (failure.message.includes("ANTHROPIC_AUTH_TOKEN")) {
      assert.match(
        failure.message,
        /gateway's own credentials|unset ANTHROPIC_AUTH_TOKEN|whichever of/,
        "the tradeoff must be stated wherever that variable is suggested",
      );
    }
  }
});

// ── aliases, because the client dedupes ──────────────────────────────────────

test("an `expose` alias is published and routes to the same upstream", async () => {
  const { resolveRoute } = await import("../server/routes/resolve.ts");
  const t = parseRouteTable(
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
          id: "s",
          match: "claude-sonnet-*",
          upstream: "fireworks",
          model: "accounts/x/kimi",
          expose: "claude-sonnet-5-fireworks",
        },
      ],
    }),
  );

  // Published, so it survives the client's dedupe against its built-in list.
  assert.ok(buildModelMenu(t).some((m) => m.id === "claude-sonnet-5-fireworks"));

  // And routable — the menu and the router agree by construction, so there is
  // no way to publish an id that cannot be served.
  const d = resolveRoute(t, "claude-sonnet-5-fireworks");
  assert.equal(d.pipeline, "substitute");
  assert.equal(d.servedModel, "accounts/x/kimi");
  assert.equal(d.route?.id, "s");
});

test("every published id is routable", async () => {
  const { resolveRoute } = await import("../server/routes/resolve.ts");
  const t = parseRouteTable(
    JSON.stringify({
      upstreams: {
        fw: { adapter: "fireworks", baseUrl: "https://x.test", credential: "{env:K}" },
      },
      routes: [
        { id: "a", match: "claude-sonnet-*", upstream: "fw", model: "m1", expose: "claude-sonnet-5-fw" },
        { id: "b", match: "claude-opus-5", upstream: null },
      ],
    }),
  );
  for (const entry of buildModelMenu(t)) {
    // Not necessarily substituted — but never a 404 either.
    assert.doesNotThrow(() => resolveRoute(t, entry.id), entry.id);
  }
});

test("an alias that the client would filter out is rejected at boot", () => {
  // Publishing it would make the entry VANISH rather than error, and the
  // operator would have no way to tell the difference from a working config.
  assert.throws(
    () =>
      parseRouteTable(
        JSON.stringify({
          upstreams: { fw: { adapter: "fireworks", baseUrl: "https://x.test", credential: "{env:K}" } },
          routes: [{ id: "a", match: "m", upstream: "fw", expose: "kimi-k2-fast" }],
        }),
      ),
    /does not match/,
  );
});

test("a wildcard alias is rejected — it is what a developer selects", () => {
  assert.throws(
    () =>
      parseRouteTable(
        JSON.stringify({
          upstreams: { fw: { adapter: "fireworks", baseUrl: "https://x.test", credential: "{env:K}" } },
          routes: [{ id: "a", match: "m", upstream: "fw", expose: "claude-*" }],
        }),
      ),
    /concrete id/,
  );
});

test("two routes cannot claim the same alias", () => {
  assert.throws(
    () =>
      parseRouteTable(
        JSON.stringify({
          upstreams: { fw: { adapter: "fireworks", baseUrl: "https://x.test", credential: "{env:K}" } },
          routes: [
            { id: "a", match: "m1", upstream: "fw", expose: "claude-x-1" },
            { id: "b", match: "m2", upstream: "fw", expose: "claude-x-1" },
          ],
        }),
      ),
    /already used/,
  );
});
