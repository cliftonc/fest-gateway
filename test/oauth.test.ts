/**
 * Provider construction and the email domain allow-list — the pure pieces
 * behind `/api/auth/oauth/*`. The HTTP wiring is exercised separately in
 * test/oauth-http.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Google, GitHub } from "arctic";
import { loadConfig } from "../server/config.ts";
import { googleProvider, githubProvider, configuredProviders, emailDomainAllowed } from "../server/auth/oauth.ts";

function cfg(overrides: Partial<ReturnType<typeof loadConfig>> = {}): ReturnType<typeof loadConfig> {
  return { ...loadConfig(), ...overrides };
}

test("googleProvider is null unless both client id and secret are set", () => {
  assert.equal(googleProvider(cfg()), null);
  assert.equal(googleProvider(cfg({ googleClientId: "id" })), null);
  assert.equal(googleProvider(cfg({ googleClientSecret: "secret" })), null);
  assert.ok(googleProvider(cfg({ googleClientId: "id", googleClientSecret: "secret" })) instanceof Google);
});

test("githubProvider is null unless both client id and secret are set", () => {
  assert.equal(githubProvider(cfg()), null);
  assert.ok(githubProvider(cfg({ githubClientId: "id", githubClientSecret: "secret" })) instanceof GitHub);
});

test("configuredProviders lists exactly the providers with credentials", () => {
  assert.deepEqual(configuredProviders(cfg()), []);
  assert.deepEqual(configuredProviders(cfg({ googleClientId: "id", googleClientSecret: "s" })), ["google"]);
  assert.deepEqual(
    configuredProviders(cfg({ googleClientId: "id", googleClientSecret: "s", githubClientId: "id", githubClientSecret: "s" })),
    ["google", "github"],
  );
});

test("emailDomainAllowed refuses everything when the allow-list is empty", () => {
  assert.equal(emailDomainAllowed(cfg({ allowedEmailDomains: [] }), "ada@corp.test"), false);
});

test("emailDomainAllowed matches case-insensitively against the configured domains", () => {
  const c = cfg({ allowedEmailDomains: ["corp.test"] });
  assert.equal(emailDomainAllowed(c, "ada@corp.test"), true);
  assert.equal(emailDomainAllowed(c, "ada@CORP.TEST"), true);
  assert.equal(emailDomainAllowed(c, "ada@other.test"), false);
  assert.equal(emailDomainAllowed(c, "not-an-email"), false);
});
