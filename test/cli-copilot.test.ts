import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCopilotEnv,
  copilotArgs,
  planFromApiEndpoint,
  planFromUserCache,
  userCacheCandidates,
} from "../cli/copilot.ts";
import { BASE_MODELS } from "../shared/base-models.ts";

const CFG = { serverUrl: "https://fest.example.com", identityToken: "fest_secrettoken123" };

test("the default is Anthropic BYOK on the developer's own key, identified by header", () => {
  const env = buildCopilotEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-x" }, CFG, "anthropic");
  assert.equal(env["COPILOT_PROVIDER_TYPE"], "anthropic");
  // Copilot appends /v1/messages itself (observed via the capture server).
  assert.equal(env["COPILOT_PROVIDER_BASE_URL"], "https://fest.example.com");
  assert.equal(env["COPILOT_PROVIDER_API_KEY"], "sk-ant-api03-x");
  assert.deepEqual(env["COPILOT_PROVIDER_HEADERS"]?.split("\n"), [
    "X-Fest-Client: copilot",
    "X-Fest-Token: fest_secrettoken123",
  ]);
  assert.ok(BASE_MODELS.some((m) => m.id === env["COPILOT_MODEL"]), "a model the gateway knows");
});

test("a developer's own COPILOT_MODEL is kept", () => {
  const env = buildCopilotEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-x", COPILOT_MODEL: "claude-opus-5" }, CFG, "anthropic");
  assert.equal(env["COPILOT_MODEL"], "claude-opus-5");
});

test("gw mode puts the Fest token in the bearer position and needs no key", () => {
  const env = buildCopilotEnv({}, CFG, "gw");
  assert.equal(env["COPILOT_PROVIDER_BEARER_TOKEN"], CFG.identityToken);
  assert.equal(env["COPILOT_PROVIDER_API_KEY"], undefined);
});

test("openai mode targets the /openai mount on the Responses wire", () => {
  const env = buildCopilotEnv({ OPENAI_API_KEY: "sk-proj-x", COPILOT_MODEL: "gpt-5.5" }, CFG, "openai");
  assert.equal(env["COPILOT_PROVIDER_TYPE"], "openai");
  assert.equal(env["COPILOT_PROVIDER_WIRE_API"], "responses");
  assert.equal(env["COPILOT_PROVIDER_BASE_URL"], "https://fest.example.com/openai/v1");
  assert.throws(() => buildCopilotEnv({ OPENAI_API_KEY: "sk-proj-x" }, CFG, "openai"), /COPILOT_MODEL/);
});

test("an inherited provider config cannot outrank Fest's", () => {
  // BEARER_TOKEN takes precedence over API_KEY in Copilot, so a stale one in
  // the shell would silently send the wrong credential.
  const env = buildCopilotEnv(
    {
      ANTHROPIC_API_KEY: "sk-ant-api03-x",
      COPILOT_PROVIDER_BEARER_TOKEN: "stale",
      COPILOT_PROVIDER_BASE_URL: "https://elsewhere.example.com",
      COPILOT_PROVIDERS_CONFIG: "/tmp/providers.json",
    },
    CFG,
    "anthropic",
  );
  assert.equal(env["COPILOT_PROVIDER_BEARER_TOKEN"], undefined);
  assert.equal(env["COPILOT_PROVIDERS_CONFIG"], undefined);
  assert.equal(env["COPILOT_PROVIDER_BASE_URL"], "https://fest.example.com");
});

test("a missing key, or a Claude subscription token, is refused with a sentence", () => {
  assert.throws(() => buildCopilotEnv({}, CFG, "anthropic"), /ANTHROPIC_API_KEY/);
  assert.throws(
    () => buildCopilotEnv({ ANTHROPIC_API_KEY: "sk-ant-oat01-x" }, CFG, "anthropic"),
    /subscription token/,
  );
});

test("subscription mode points Copilot's API URL at the plan's mount, token in the path", () => {
  const env = buildCopilotEnv({}, { ...CFG, plan: "business" }, "subscription");
  assert.equal(env["COPILOT_API_URL"], "https://fest.example.com/t/fest_secrettoken123/copilot/business");
  assert.equal(env["COPILOT_PROVIDER_BASE_URL"], undefined);
  assert.equal(env["COPILOT_PROVIDER_HEADERS"], undefined);
  assert.equal(env["COPILOT_MODEL"], undefined, "Copilot's own model choice stands");
});

test("subscription mode clears anything that would take the session off the plan or off Fest", () => {
  const env = buildCopilotEnv(
    {
      COPILOT_PROVIDER_BASE_URL: "https://elsewhere.example.com",
      COPILOT_PROVIDER_API_KEY: "sk-x",
      COPILOT_PROVIDERS_CONFIG: "/tmp/providers.json",
      COPILOT_API_URL: "https://api.individual.githubcopilot.com",
      COPILOT_OFFLINE: "true",
      COPILOT_GITHUB_TOKEN: "github_pat_kept",
    },
    { ...CFG, plan: "individual" },
    "subscription",
  );
  for (const name of ["COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDERS_CONFIG", "COPILOT_OFFLINE"]) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env["COPILOT_API_URL"], "https://fest.example.com/t/fest_secrettoken123/copilot/individual");
  // Which GitHub login Copilot uses is the developer's business.
  assert.equal(env["COPILOT_GITHUB_TOKEN"], "github_pat_kept");
});

test("a plan is read only from GitHub's three plan hosts", () => {
  assert.equal(planFromApiEndpoint("https://api.individual.githubcopilot.com"), "individual");
  assert.equal(planFromApiEndpoint("https://api.enterprise.githubcopilot.com/"), "enterprise");
  assert.equal(planFromApiEndpoint("https://api.githubcopilot.com"), null);
  assert.equal(planFromApiEndpoint("https://copilot-api.acme.ghe.com"), null);
  assert.equal(planFromApiEndpoint("http://api.business.githubcopilot.com"), null);
});

test("the plan comes from the most recently refreshed account in Copilot's cache", () => {
  const cache = [
    "// Disposable cache for Copilot user responses, safe to delete. Managed automatically.",
    "// User settings belong in settings.json.",
    JSON.stringify({
      copilotUserCache: {
        "v1:aaa": { retrievedAt: "2026-09-20T06:10:00Z", response: { endpoints: { api: "https://api.individual.githubcopilot.com" } } },
        "v1:bbb": { retrievedAt: "2026-10-13T08:43:00Z", response: { endpoints: { api: "https://api.business.githubcopilot.com" } } },
      },
    }),
  ].join("\n");
  assert.deepEqual(planFromUserCache(cache), { plan: "business", api: "https://api.business.githubcopilot.com" });
  const ghe = JSON.stringify({ copilotUserCache: { "v1:c": { response: { endpoints: { api: "https://copilot-api.acme.ghe.com" } } } } });
  assert.deepEqual(planFromUserCache(ghe), { plan: null, api: "https://copilot-api.acme.ghe.com" });
  assert.equal(planFromUserCache("not json"), null);
  assert.equal(planFromUserCache("{}"), null);
});

test("Copilot's cache is looked for where each platform keeps it", () => {
  assert.deepEqual(userCacheCandidates({}, "/Users/dev", "darwin"), [
    "/Users/dev/Library/Caches/copilot/copilot-user-cache.json",
    "/Users/dev/.cache/copilot/copilot-user-cache.json",
  ]);
  assert.equal(userCacheCandidates({ COPILOT_CACHE_HOME: "/c" }, "/home/dev", "linux")[0], "/c/copilot-user-cache.json");
  assert.equal(
    userCacheCandidates({ XDG_CACHE_HOME: "/x" }, "/home/dev", "linux").at(-1),
    "/x/copilot/copilot-user-cache.json",
  );
});

test("under a path-mounted gateway the built-in GitHub MCP server is switched off", () => {
  // Copilot calls it at the API URL's origin, which a path-mounted Fest does not own.
  assert.deepEqual(copilotArgs("https://corp.example.com/fest", "subscription", ["-p", "hi"]), [
    "--disable-mcp-server",
    "github-mcp-server",
    "-p",
    "hi",
  ]);
  assert.deepEqual(copilotArgs("https://fest.example.com", "subscription", ["-p", "hi"]), ["-p", "hi"]);
  assert.deepEqual(copilotArgs("https://corp.example.com/fest", "anthropic", []), []);
});
