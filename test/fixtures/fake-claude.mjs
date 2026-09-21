#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary, so the version canary can be tested
 * without a subscription, a network, or a particular Claude Code release
 * installed.
 *
 * It reproduces only what the canary reads: a `--version` line, and one
 * `/v1/messages` request to ANTHROPIC_BASE_URL carrying a chosen credential.
 * Behaviour is driven by env so a test can stage the exact regression the
 * canary exists to catch.
 *
 *   FAKE_CLAUDE_VERSION   version string to report        (default 9.9.9)
 *   FAKE_CLAUDE_CRED      subscription | apikey | none    (default subscription)
 *   FAKE_CLAUDE_BETA      anthropic-beta header value     (default includes oauth-2025-04-20)
 *   FAKE_CLAUDE_SILENT    =1 to make no request at all
 */

const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log(`${process.env.FAKE_CLAUDE_VERSION ?? "9.9.9"} (Claude Code)`);
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_SILENT === "1") process.exit(0);

const base = process.env.ANTHROPIC_BASE_URL;
if (!base) {
  console.error("fake-claude: ANTHROPIC_BASE_URL not set");
  process.exit(1);
}

const prompt = args[args.indexOf("-p") + 1] ?? "hi";
const cred = process.env.FAKE_CLAUDE_CRED ?? "subscription";

const headers = {
  "content-type": "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": process.env.FAKE_CLAUDE_BETA ?? "oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
  "user-agent": "claude-cli/fake (external, cli)",
  "x-claude-code-session-id": "00000000-0000-4000-8000-000000000000",
};
// The real client is exclusive here: an API key replaces the bearer, it never
// rides alongside it. The canary's demotion check depends on that.
if (cred === "subscription") headers.authorization = "Bearer sk-ant-oat01-FAKECANARYTOKEN";
else if (cred === "apikey") headers["x-api-key"] = "sk-ant-api03-FAKECANARYKEY";

const res = await fetch(new URL("/v1/messages?beta=true", base), {
  method: "POST",
  headers,
  body: JSON.stringify({
    model: "claude-opus-5",
    max_tokens: 64,
    stream: true,
    system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: prompt }],
  }),
});

const body = await res.text();
console.log(`fake-claude: ${res.status}\n${body.slice(0, 400)}`);
process.exit(res.ok ? 0 : 1);
