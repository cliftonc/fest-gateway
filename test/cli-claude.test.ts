/**
 * `fest claude`: the child environment it spawns into, and the preflight that
 * decides whether that child can actually serve a turn.
 *
 * Everything here runs against pure helpers — no real `claude` binary, and
 * (apart from the deliberately stubbed `fetch`) no socket. The properties that
 * matter:
 *
 *  - subscription posture: every var in `shared/demotion-vars.ts` is gone from
 *    the child even when present in the parent, so a developer can never be
 *    silently demoted off their own subscription by an inherited env var;
 *  - gateway posture: the Fest token is set *after* that strip, so an inherited
 *    `ANTHROPIC_API_KEY` can never survive alongside it;
 *  - the servability preflight catches the unrouted-base-model cliff before the
 *    session opens, rather than as a 401 on the first message.
 *
 * `HOME` and the cwd are both redirected before importing `cli/claude.ts`: the
 * settings scan reads four real paths derived from them, and this test must
 * never read a developer's own `~/.claude` — nor be steered by the repo's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMOTION_VARS } from "../shared/demotion-vars.ts";
import { BASE_MODELS } from "../shared/base-models.ts";

const fakeHome = mkdtempSync(join(tmpdir(), "fest-claudehome-"));
const fakeCwd = mkdtempSync(join(tmpdir(), "fest-claudecwd-"));
const realCwd = process.cwd();
process.env.HOME = fakeHome;
process.chdir(fakeCwd);

const {
  buildClaudeEnv,
  detectSubscriptionLogin,
  settingsDemotionTriggers,
  resolveIntendedModel,
  checkServable,
  fetchServableModels,
  postureWarnings,
} = await import("../cli/claude.ts");

test.after(() => {
  process.chdir(realCwd);
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(fakeCwd, { recursive: true, force: true });
});

/** Write one settings layer under the redirected HOME or cwd. */
function writeSettings(root: string, name: string, body: unknown): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", name), JSON.stringify(body));
}

function clearSettings(): void {
  rmSync(join(fakeHome, ".claude"), { recursive: true, force: true });
  rmSync(join(fakeCwd, ".claude"), { recursive: true, force: true });
  rmSync(join(fakeHome, ".claude.json"), { force: true });
}

const CFG = { serverUrl: "http://localhost:8787", identityToken: "fest_abc" };

// ---------------------------------------------------------------------------
// buildClaudeEnv
// ---------------------------------------------------------------------------

test("sets ANTHROPIC_BASE_URL to the path-prefixed identity carrier", () => {
  const env = buildClaudeEnv({ PATH: "/usr/bin" }, CFG);
  assert.equal(env["ANTHROPIC_BASE_URL"], "http://localhost:8787/t/fest_abc");
  assert.equal(env["PATH"], "/usr/bin");
});

test("strips every demotion var even when present in the parent env", () => {
  const parent: Record<string, string> = { PATH: "/usr/bin" };
  for (const v of DEMOTION_VARS) parent[v] = "poisoned";

  const env = buildClaudeEnv(parent, CFG);

  for (const v of DEMOTION_VARS) {
    if (v === "ANTHROPIC_BASE_URL") continue;
    assert.equal(env[v], undefined, `${v} must not reach the child`);
  }
  // The one demotion var Fest itself sets is set to Fest's own value, not the
  // parent's poisoned one.
  assert.equal(env["ANTHROPIC_BASE_URL"], "http://localhost:8787/t/fest_abc");
});

test("does not mutate the base env object passed in", () => {
  const parent = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "poisoned" };
  buildClaudeEnv(parent, { serverUrl: "http://localhost:8787", identityToken: "t" });
  assert.equal(parent.ANTHROPIC_API_KEY, "poisoned");
});

test("gateway posture: bare base URL, Fest token, nothing inherited survives", () => {
  const parent: Record<string, string> = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-someone-elses",
    ANTHROPIC_AUTH_TOKEN: "inherited",
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
  };

  const env = buildClaudeEnv(parent, CFG, "key");

  // No `/t/` prefix: in this posture identity rides in the header, not the path.
  assert.equal(env["ANTHROPIC_BASE_URL"], "http://localhost:8787");
  assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "fest_abc");
  // Strip-then-set, so the inherited key is gone rather than sitting alongside.
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  // Discovery is not a demotion var, and gateway posture exists to use it.
  assert.equal(env["CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"], "1");
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("subscription login is detected from oauthAccount, absent otherwise", () => {
  clearSettings();
  assert.equal(detectSubscriptionLogin().ok, false);

  writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ oauthAccount: { seatTier: "max" } }));
  assert.equal(detectSubscriptionLogin().ok, true);

  writeFileSync(join(fakeHome, ".claude.json"), JSON.stringify({ someOtherKey: true }));
  assert.equal(detectSubscriptionLogin().ok, false);

  clearSettings();
});

test("the settings scan reports the key and never the value", () => {
  clearSettings();
  assert.deepEqual(settingsDemotionTriggers(), []);

  writeSettings(fakeHome, "settings.json", { env: { ANTHROPIC_API_KEY: "sk-live-secret" } });
  writeSettings(fakeCwd, "settings.local.json", { apiKeyHelper: "/usr/local/bin/get-key" });

  const found = settingsDemotionTriggers();
  assert.equal(found.length, 2);
  assert.ok(found.some((f) => f.endsWith(": env.ANTHROPIC_API_KEY")));
  assert.ok(found.some((f) => f.endsWith(": apiKeyHelper")));
  // The whole point: a settings file's env values are live secrets.
  assert.ok(!found.join(" ").includes("sk-live-secret"));
  assert.ok(!found.join(" ").includes("get-key"));

  clearSettings();
});

test("a settings trigger is only warned about in subscription posture", () => {
  const triggers = ["/x/.claude/settings.json: apiKeyHelper"];
  const sub = postureWarnings("subscription", {}, triggers);
  assert.ok(sub.some((w) => w.includes("demote this session off your subscription")));
  // Gateway posture is already on org credentials; a demotion trigger there is
  // not news.
  assert.deepEqual(postureWarnings("key", { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" }, []), []);
});

test("discovery warnings point each posture at what it can actually do", () => {
  const sub = postureWarnings("subscription", { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1" }, []);
  assert.ok(sub.some((w) => w.includes("fest claude gw")));

  const gw = postureWarnings("key", {}, []);
  assert.ok(gw.some((w) => w.includes("CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1")));

  const assumed = postureWarnings("key", {
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
  }, []);
  assert.ok(assumed.some((w) => w.includes("_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL")));
});

// ---------------------------------------------------------------------------
// resolveIntendedModel
// ---------------------------------------------------------------------------

test("--model beats ANTHROPIC_MODEL beats a settings model key", () => {
  clearSettings();
  writeSettings(fakeHome, "settings.json", { model: "from-settings" });

  assert.equal(resolveIntendedModel(["--model", "from-argv"], { ANTHROPIC_MODEL: "from-env" }), "from-argv");
  assert.equal(resolveIntendedModel(["--model=from-argv"], { ANTHROPIC_MODEL: "from-env" }), "from-argv");
  assert.equal(resolveIntendedModel([], { ANTHROPIC_MODEL: "from-env" }), "from-env");
  assert.equal(resolveIntendedModel([], {}), "from-settings");

  // The most specific layer wins, as the client merges them.
  writeSettings(fakeCwd, "settings.local.json", { model: "from-project-local" });
  assert.equal(resolveIntendedModel([], {}), "from-project-local");

  clearSettings();
  // Nothing observable: the client's own default or last selection.
  assert.equal(resolveIntendedModel([], {}), null);
});

test("a dangling --model is not read as a model id", () => {
  clearSettings();
  assert.equal(resolveIntendedModel(["--resume", "--model"], {}), null);
});

// ---------------------------------------------------------------------------
// checkServable — the cliff
// ---------------------------------------------------------------------------

/**
 * What the repo's own `routes.json` actually publishes: `claude-sonnet-*` →
 * kimi (exposed as `claude-kimi-k2-code`) and `claude-deepseek-v4`. Opus 5 and
 * Haiku 4.5 have no route, so they are absent — while the menu is non-empty,
 * which is exactly why "the menu loaded" is not the question being asked.
 */
const MENU = ["claude-sonnet-5", "claude-kimi-k2-code", "claude-deepseek-v4"];

test("a servable intended model passes silently", () => {
  assert.equal(checkServable(MENU, "claude-deepseek-v4").kind, "ok");
});

test("an unroutable intended model is fatal, and names the alternatives", () => {
  const verdict = checkServable(MENU, "claude-opus-5");
  assert.equal(verdict.kind, "fatal");
  assert.ok(verdict.message.includes("claude-opus-5"));
  for (const id of MENU) assert.ok(verdict.message.includes(id), `should list ${id}`);
});

test("an unknown intended model warns about exactly the unrouted base models", () => {
  const verdict = checkServable(MENU, null);
  assert.equal(verdict.kind, "warn");
  assert.ok(verdict.message.includes("Opus 5"));
  assert.ok(verdict.message.includes("Haiku 4.5"));
  // Sonnet 5 IS routed here, so naming it would be a false alarm — and a false
  // alarm is how a warning stops being read.
  assert.ok(!verdict.message.includes("Sonnet 5"));
});

test("a menu covering every base model warns about nothing", () => {
  // Derived from BASE_MODELS rather than written out: this test means "every
  // base model is servable", and a hand-listed menu quietly stops meaning that
  // the moment Anthropic ships one — which is exactly how it broke when Fable
  // 5.1 was added to the list.
  const everything = [...MENU, ...BASE_MODELS.map((m) => m.id)];
  assert.equal(checkServable(everything, null).kind, "ok");
});

// ---------------------------------------------------------------------------
// fetchServableModels
// ---------------------------------------------------------------------------

function mockModels(t: { mock: { method: (...a: any[]) => any } }, handler: (url: string) => Promise<Response>): void {
  t.mock.method(globalThis, "fetch", async (input: any) => {
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
    return handler(url);
  });
}

test("a served menu is reduced to its ids", async (t) => {
  mockModels(t, async (url) => {
    assert.equal(url, "http://example.test/v1/models?limit=1000");
    return new Response(JSON.stringify({ data: [{ id: "claude-deepseek-v4" }, { id: "claude-kimi-k2-code" }] }), {
      status: 200,
    });
  });
  const res = await fetchServableModels("http://example.test");
  assert.deepEqual(res, { ok: true, ids: ["claude-deepseek-v4", "claude-kimi-k2-code"] });
});

test("404 is fatal: gateway posture with no routes can serve nothing", async (t) => {
  mockModels(t, async () => new Response("{}", { status: 404 }));
  const res = await fetchServableModels("http://example.test");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.fatal, true);
  assert.ok(res.ok === false && res.message.includes("FEST_ROUTES"));
});

test("an empty data array is fatal too", async (t) => {
  mockModels(t, async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
  const res = await fetchServableModels("http://example.test");
  assert.equal(res.ok === false && res.fatal, true);
});

test("a network error only warns — a flaky link must not brick a good gateway", async (t) => {
  mockModels(t, async () => {
    throw new Error("ECONNREFUSED");
  });
  const res = await fetchServableModels("http://example.test");
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.fatal, false);
  assert.ok(res.ok === false && res.message.includes("continuing unchecked"));
});
