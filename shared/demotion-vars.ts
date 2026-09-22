/**
 * Env vars that demote Claude Code off subscription auth onto key auth.
 *
 * Setting any of these makes `isAnthropicAuthEnabled()` return false, silently
 * moving a developer off their own Max/Team subscription onto whatever key the
 * gateway holds. `tools/canary.ts` clears these before spawning a *test*
 * client; `cli/claude.ts` clears them before spawning a *developer's* client,
 * for the identical reason. One list, so they cannot drift apart.
 */
export const DEMOTION_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
] as const;
