/**
 * Which coding agent sent a request, and which of its sessions it belongs to.
 *
 * Fest fronts three clients, and each identifies itself differently. All of it
 * was read off real traffic (the capture server, October 2026), because none
 * of these headers is a documented contract:
 *
 *  - Claude Code sends `x-claude-code-session-id`, and a `claude-cli/…`
 *    user-agent.
 *  - Codex sends `originator: codex_cli_rs` (interactive) or `codex_exec`
 *    (`codex exec`), a `codex_…/<version>` user-agent, and `session-id`.
 *  - Copilot CLI in BYOK mode uses the stock Anthropic or OpenAI SDK, so its
 *    user-agent is the SDK's (`Anthropic/JS 0.94.0`). What gives it away is
 *    GitHub's own pair, `x-initiator` and `x-interaction-type`, which it adds
 *    to every model call. It sends no session id at all.
 *  - Copilot CLI on its own login (the `/copilot` mount) talks to GitHub's
 *    Copilot API, and sends that API's headers: `copilot-integration-id`
 *    (`copilot-developer-cli`) on every call, and `x-client-session-id`, the
 *    same id `copilot --resume` takes.
 *
 * `fest codex` and `fest copilot` also send `X-Fest-Client`, which wins when
 * present (`x-fest-*` is stripped before anything goes upstream). The sniffing
 * below is for clients a developer pointed at Fest by hand.
 *
 * Detection is best-effort labelling for the dashboard, never a security
 * decision: every one of these headers is caller-controlled.
 */

type Headers = Readonly<Record<string, string | string[] | undefined>>;

export type Client = "claude-code" | "codex" | "copilot";

function first(headers: Headers, name: string): string | null {
  const v = headers[name];
  if (v === undefined) return null;
  const one = Array.isArray(v) ? v[0] : v;
  return one === undefined || one === "" ? null : one;
}

export function detectClient(headers: Headers): Client | null {
  const declared = first(headers, "x-fest-client");
  if (declared === "claude-code" || declared === "codex" || declared === "copilot") return declared;
  const originator = first(headers, "originator");
  const ua = first(headers, "user-agent") ?? "";
  if (originator?.startsWith("codex") || /^codex[_-]/i.test(ua)) return "codex";
  if (first(headers, "x-claude-code-session-id") !== null || ua.startsWith("claude-cli/")) {
    return "claude-code";
  }
  if (first(headers, "x-initiator") !== null && first(headers, "x-interaction-type") !== null) {
    return "copilot";
  }
  if (first(headers, "copilot-integration-id") !== null) return "copilot";
  return null;
}

/** The client's own session id, in whichever header it puts one. */
export function sessionIdOf(headers: Headers): string | null {
  return (
    first(headers, "x-claude-code-session-id") ??
    first(headers, "session-id") ??
    first(headers, "session_id") ??
    first(headers, "x-client-session-id") ??
    null
  );
}
