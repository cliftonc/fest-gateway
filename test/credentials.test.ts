/**
 * Credential resolution, and the two rules that make substitution safe.
 *
 * These are the highest-consequence assertions in the phase. Failing either one
 * is not a bug that produces an error — it is a bug that produces a SUCCESS
 * with the wrong credential, which nobody investigates.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createEnvResolver, parseSecretRef, explainSecretRef } from "../server/credentials/provider.ts";
import { resolveCredential } from "../server/credentials/resolve.ts";
import { parseRouteTable } from "../server/routes/table.ts";
import { resolveRoute } from "../server/routes/resolve.ts";
import { NonPersistable, REDACTED } from "../server/secret/non-persistable.ts";

const SECRET = "fw_thisisarealsecretvalue";

const table = parseRouteTable(
  JSON.stringify({
    upstreams: {
      fireworks: {
        adapter: "fireworks",
        baseUrl: "https://api.fireworks.ai/inference",
        credential: "{env:FIREWORKS_API_KEY}",
      },
    },
    routes: [{ id: "oss", match: "gpt-oss-*", upstream: "fireworks", model: "accounts/x/oss" }],
  }),
);

const substitute = resolveRoute(table, "gpt-oss-120b");
const passthrough = resolveRoute(table, "claude-opus-5");

const withKey = createEnvResolver({ FIREWORKS_API_KEY: SECRET });
const withoutKey = createEnvResolver({});

const SUBSCRIPTION = { fingerprint: "abc123", isSubscription: true };
const INBOUND_KEY = { fingerprint: "def456", isSubscription: false };

// ── secret references ─────────────────────────────────────────────────────────

test("only {env:NAME} is a valid reference", () => {
  assert.deepEqual(parseSecretRef("{env:FOO}"), { kind: "env", name: "FOO", source: "env:FOO" });
  for (const bad of ["FOO", "${FOO}", "{env:}", "{file:/x}", "{env:9bad}", ""]) {
    assert.equal(parseSecretRef(bad), null, bad);
  }
});

test("an empty environment variable counts as missing, not as a credential", () => {
  // `FIREWORKS_API_KEY=` in a .env file is a mistake essentially every time.
  // Treating it as a value turns "not configured" into a confusing upstream 401.
  for (const value of ["", "   "]) {
    assert.equal(createEnvResolver({ K: value }).resolve({ kind: "env", name: "K", source: "env:K" }), null);
  }
});

test("explainSecretRef names the fix when a literal secret is pasted", () => {
  assert.equal(explainSecretRef("{env:OK}"), null);
  assert.match(explainSecretRef(SECRET) ?? "", /environment variable/);
  assert.match(explainSecretRef("") ?? "", /empty/);
});

// ── the two rules ─────────────────────────────────────────────────────────────

test("RULE: a subscription bearer is never used for a substitute route", () => {
  const out = resolveCredential(substitute, SUBSCRIPTION, withKey);
  assert.equal(out.ok, true);
  assert.ok(out.ok);

  const skipped = out.considered.find((c) => c.source === "inbound_subscription");
  assert.equal(skipped?.result, "skipped", "it must be recorded, not merely unused");
  assert.match(skipped?.reason ?? "", /only valid at Anthropic/);

  assert.equal(out.source, "env:FIREWORKS_API_KEY");
  assert.equal(out.secret?.expose(), SECRET);
});

test("RULE: a missing server credential refuses the request rather than falling back", () => {
  const out = resolveCredential(substitute, SUBSCRIPTION, withoutKey);
  assert.equal(out.ok, false);
  assert.ok(!out.ok);

  // The message must name the route, the upstream and the variable — an
  // operator reading it should not need to open the config to act.
  assert.match(out.message, /"oss"/);
  assert.match(out.message, /"fireworks"/);
  assert.match(out.message, /env:FIREWORKS_API_KEY/);
  assert.match(out.message, /refused rather than served on a different credential/);

  assert.deepEqual(
    out.considered.map((c) => [c.source, c.result]),
    [
      ["inbound_subscription", "skipped"],
      ["env:FIREWORKS_API_KEY", "missing"],
    ],
  );
  assert.equal(
    out.considered.some((c) => c.result === "used"),
    false,
    "nothing may be marked used when the request was refused",
  );
});

test("an inbound API key is also not forwarded to another vendor", () => {
  const out = resolveCredential(substitute, INBOUND_KEY, withKey);
  assert.ok(out.ok);
  assert.equal(out.considered.find((c) => c.source === "inbound_key")?.result, "skipped");
});

test("pass-through uses the caller's own credential and records it as used", () => {
  const out = resolveCredential(passthrough, SUBSCRIPTION, withoutKey);
  assert.ok(out.ok);
  assert.equal(out.secret, null, "pass-through relays the inbound credential, never a held one");
  assert.deepEqual(out.considered, [{ source: "inbound_subscription", result: "used" }]);
});

test("pass-through with no credential is not an error here — upstream decides", () => {
  // Anthropic's own 401 is a better message than anything Fest could invent,
  // and the client's refresh-and-retry latch is waiting for exactly that.
  const out = resolveCredential(passthrough, null, withoutKey);
  assert.ok(out.ok);
  assert.equal(out.considered[0]?.result, "missing");
});

test("exactly one credential is ever marked used", () => {
  for (const [decision, inbound, secrets] of [
    [substitute, SUBSCRIPTION, withKey],
    [passthrough, SUBSCRIPTION, withKey],
    [substitute, null, withKey],
  ] as const) {
    const out = resolveCredential(decision, inbound, secrets);
    assert.ok(out.ok);
    assert.equal(out.considered.filter((c) => c.result === "used").length, 1);
  }
});

// ── the audit trail cannot itself leak ────────────────────────────────────────

test("no considered entry can contain a secret value", () => {
  const cases = [
    resolveCredential(substitute, SUBSCRIPTION, withKey),
    resolveCredential(substitute, SUBSCRIPTION, withoutKey),
    resolveCredential(passthrough, SUBSCRIPTION, withKey),
  ];
  for (const out of cases) {
    const json = JSON.stringify(out.considered);
    assert.equal(json.includes(SECRET), false);
    assert.equal(json.includes("fw_"), false, "not even a prefix of the real value");
  }
});

// ── NonPersistable ────────────────────────────────────────────────────────────

test("a wrapped secret cannot be stringified, serialised or inspected by accident", () => {
  const secret = new NonPersistable(SECRET);

  assert.equal(String(secret), REDACTED);
  assert.equal(`${secret}`, REDACTED);
  assert.equal(secret + "", REDACTED);
  assert.equal(JSON.stringify(secret), `"${REDACTED}"`);
  assert.equal(JSON.stringify({ key: secret }), `{"key":"${REDACTED}"}`);
  assert.equal(JSON.stringify([secret]), `["${REDACTED}"]`);

  // util.inspect is what console.log and most loggers actually use, and it
  // ignores toString entirely.
  const inspected = (secret as unknown as Record<symbol, () => string>)[
    Symbol.for("nodejs.util.inspect.custom")
  ]?.();
  assert.equal(inspected, `NonPersistable ${REDACTED}`);

  // A private field is invisible to enumeration, so even without toJSON the
  // value does not escape. Two mechanisms have to fail, not one.
  assert.deepEqual(Object.keys(secret), []);
  assert.equal(JSON.stringify({ ...secret }), "{}");

  assert.equal(secret.expose(), SECRET, "and it is still readable on purpose");
});
