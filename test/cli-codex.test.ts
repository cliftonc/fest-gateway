import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCodexInvocation, detectCodexMode, TOKEN_ENV } from "../cli/codex.ts";

const CFG = { serverUrl: "https://fest.example.com", identityToken: "fest_secrettoken123" };

/** `-c` values, as a key → value map. */
function overrides(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], "-c");
    const [k, ...v] = args[i + 1]!.split("=");
    out[k!] = v.join("=");
  }
  return out;
}

test("a ChatGPT login is pointed at the /chatgpt mount on Codex's own auth", () => {
  const { args } = buildCodexInvocation({}, CFG, "chatgpt");
  const c = overrides(args);
  assert.equal(c["model_provider"], '"fest"');
  assert.equal(c["model_providers.fest.base_url"], '"https://fest.example.com/chatgpt/backend-api/codex"');
  assert.equal(c["model_providers.fest.wire_api"], '"responses"');
  assert.equal(c["model_providers.fest.requires_openai_auth"], "true");
  assert.equal(c["model_providers.fest.env_key"], undefined);
});

test("API-key mode reads OPENAI_API_KEY when it is set, and Codex's stored login otherwise", () => {
  const withEnv = overrides(buildCodexInvocation({ OPENAI_API_KEY: "sk-proj-x" }, CFG, "key").args);
  assert.equal(withEnv["model_providers.fest.base_url"], '"https://fest.example.com/openai/v1"');
  assert.equal(withEnv["model_providers.fest.env_key"], '"OPENAI_API_KEY"');

  const stored = overrides(buildCodexInvocation({}, CFG, "key").args);
  assert.equal(stored["model_providers.fest.requires_openai_auth"], "true");
});

test("the identity token travels in the child's environment, never in argv", () => {
  const { args, env } = buildCodexInvocation({ PATH: "/bin" }, CFG, "chatgpt");
  assert.equal(args.join(" ").includes(CFG.identityToken), false, "argv is visible to ps");
  assert.equal(env[TOKEN_ENV], CFG.identityToken);
  assert.match(overrides(args)["model_providers.fest.env_http_headers"]!, /"X-Fest-Token" = "FEST_GATEWAY_TOKEN"/);
  assert.equal(env["PATH"], "/bin", "the rest of the environment is inherited");
});

test("the login mode is read from auth_mode, and only that", () => {
  const home = mkdtempSync(join(tmpdir(), "fest-codex-home-"));
  assert.equal(detectCodexMode({ CODEX_HOME: home }).mode, "key", "no auth.json");

  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "eyJ…" } }));
  const chatgpt = detectCodexMode({ CODEX_HOME: home });
  assert.equal(chatgpt.mode, "chatgpt");
  assert.equal(chatgpt.detail.includes("eyJ"), false);

  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-proj-x" }));
  assert.equal(detectCodexMode({ CODEX_HOME: home }).mode, "key");

  writeFileSync(join(home, "auth.json"), "{not json");
  assert.equal(detectCodexMode({ CODEX_HOME: home }).mode, "key");
});
