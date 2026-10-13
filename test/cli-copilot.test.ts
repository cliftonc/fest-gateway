import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCopilotEnv } from "../cli/copilot.ts";
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
