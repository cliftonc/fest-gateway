/**
 * Env vars that demote Claude Code off subscription auth onto key auth.
 *
 * Setting any of these makes `isAnthropicAuthEnabled()` return false, silently
 * moving a developer off their own Max/Team subscription onto whatever key the
 * gateway holds. `tools/canary.ts` clears these before spawning a *test*
 * client; `cli/claude.ts` clears them before spawning a *developer's* client,
 * for the identical reason. One list, so they cannot drift apart.
 *
 * ── Where the list comes from ────────────────────────────────────────────────
 *
 * Read out of the client, not guessed. In 2.1.278 the provider is selected by a
 * single chain, and `isAnthropicAuthEnabled` refuses subscription auth whenever
 * it does not land on `"firstParty"`:
 *
 *     CLAUDE_CODE_USE_BEDROCK               -> "bedrock"
 *     CLAUDE_CODE_USE_FOUNDRY               -> "foundry"
 *     CLAUDE_CODE_USE_ANTHROPIC_AWS         -> "anthropicAws"
 *     CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD -> "anthropicGoogleCloud"
 *     CLAUDE_CODE_USE_MANTLE                -> "mantle"
 *     CLAUDE_CODE_USE_VERTEX                -> "vertex"
 *
 * That list grew — Mantle, Foundry and the two Claude-Platform providers are
 * newer than this file — and the four additions were invisible failures: a
 * developer with `CLAUDE_CODE_USE_MANTLE=1` left in their shell would have had
 * `fest claude` hand them a subscription-posture session that was not on their
 * subscription at all. Re-read the chain when upgrading Claude Code; the
 * canary is the moment to do it.
 *
 * Deliberately NOT here:
 *
 *  - `AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_FOUNDRY_API_KEY` and friends. They
 *    are only consulted once a provider above is selected, so on their own they
 *    demote nobody — and Fest's own Bedrock support asks developers to set the
 *    AWS one deliberately. Stripping it would break the feature while
 *    protecting nothing.
 *  - The client's "gateway" posture, which comes from credential-slot and host
 *    policy state rather than from the environment. There is no variable to
 *    clear.
 */
export const DEMOTION_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
] as const;
