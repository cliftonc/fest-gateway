import { test } from "node:test";
import assert from "node:assert/strict";
import { detectClient, sessionIdOf } from "../server/http/client.ts";

// Header sets as captured from each real client, October 2026.
const CLAUDE_CODE = {
  "user-agent": "claude-cli/2.1.278 (external, sdk-cli)",
  "x-claude-code-session-id": "cc-session",
};
const CODEX_EXEC = {
  originator: "codex_exec",
  "user-agent": "codex_exec/0.162.1 (Mac OS 26.7.0; arm64) ghostty/1.3.1",
  "session-id": "01a13435-dc2c-7203-95ac-43973bd9e02c",
};
const COPILOT_BYOK = {
  "user-agent": "Anthropic/JS 0.94.0",
  "x-initiator": "user",
  "x-interaction-type": "conversation-user",
};

test("each client is recognised from what it actually sends", () => {
  assert.equal(detectClient(CLAUDE_CODE), "claude-code");
  assert.equal(detectClient(CODEX_EXEC), "codex");
  assert.equal(detectClient({ originator: "codex_cli_rs" }), "codex");
  assert.equal(detectClient(COPILOT_BYOK), "copilot");
});

test("the stock SDK alone is not mistaken for Copilot", () => {
  assert.equal(detectClient({ "user-agent": "Anthropic/JS 0.94.0" }), null);
  assert.equal(detectClient({}), null);
});

test("an explicit X-Fest-Client label wins, and only a known one", () => {
  assert.equal(detectClient({ ...COPILOT_BYOK, "x-fest-client": "codex" }), "codex");
  assert.equal(detectClient({ ...COPILOT_BYOK, "x-fest-client": "something-else" }), "copilot");
});

test("the session id comes from whichever header the client uses", () => {
  assert.equal(sessionIdOf(CLAUDE_CODE), "cc-session");
  assert.equal(sessionIdOf(CODEX_EXEC), "01a13435-dc2c-7203-95ac-43973bd9e02c");
  assert.equal(sessionIdOf(COPILOT_BYOK), null);
});

test("Copilot on its own login is recognised by its API's headers, with its session", () => {
  const headers = {
    "copilot-integration-id": "copilot-developer-cli",
    "user-agent": "copilot/1.0.96 (darwin v24.20.0) term/ghostty",
    "x-client-session-id": "7c8ab512-709c-4e6f-a76e-e65b9984e517",
  };
  assert.equal(detectClient(headers), "copilot");
  assert.equal(sessionIdOf(headers), "7c8ab512-709c-4e6f-a76e-e65b9984e517");
});
