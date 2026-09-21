/**
 * The message a developer sees when Fest cannot serve them.
 *
 * This is genuinely UI: Claude Code renders `error.message` verbatim, mid-task,
 * to someone who was trying to get work done. An error that says "unauthorized"
 * is a support ticket. One that says which variable to set is a fix.
 *
 * Two constraints learned by watching it render, both of which shape every
 * message here:
 *
 *  1. **The client TRUNCATES the message.** It is shown on roughly one line, so
 *     the first sentence has to carry the whole actionable point. Detail on
 *     later lines is a bonus that may never be seen.
 *  2. **The client RETRIES.** Its predicate is
 *     `x-should-retry` first, then 408/409/429/5xx. A permanent configuration
 *     problem returned as a retryable status produces ten escalating retries of
 *     a request that cannot possibly succeed — the developer waits a minute to
 *     be told something that was true immediately. So every failure here
 *     carries `retryable`, and callers must send `x-should-retry: false`
 *     accordingly.
 *
 * The messages differ by POSTURE because the remedies are opposite, and telling
 * a subscription user to set `ANTHROPIC_AUTH_TOKEN` would be actively harmful —
 * that variable is exactly what disables their subscription.
 */

export interface AuthFailure {
  readonly status: number;
  readonly type: "authentication_error" | "invalid_request_error";
  readonly message: string;
  /**
   * False for anything a retry cannot fix. Sent as `x-should-retry: false`,
   * which the client honours ahead of its status-code rules.
   */
  readonly retryable: boolean;
}

const DO_NOT_SET =
  "Do not set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN alongside it: either one makes " +
  "Claude Code stop using your Claude subscription and bill an API key instead.";

/** No identity token at all, on a deployment that requires one. */
export function noIdentity(baseUrl: string): AuthFailure {
  return {
    status: 401,
    type: "authentication_error",
    retryable: false,
    message:
      `Fest: no identity token — ask an admin for one, then set ANTHROPIC_BASE_URL=${baseUrl}/t/<your-token>.\n` +
      `Ask an admin for a token, then either:\n` +
      `  • point your base URL at it — ANTHROPIC_BASE_URL=${baseUrl}/t/<your-token>   (keeps your Claude subscription)\n` +
      `  • or set ANTHROPIC_AUTH_TOKEN=<your-token>                                   (uses this gateway's own credentials instead)\n` +
      `The first is preferred: it bills your own subscription rather than the team's.`,
  };
}

/** A token was presented and did not resolve. */
export function badIdentity(): AuthFailure {
  return {
    status: 401,
    type: "authentication_error",
    retryable: false,
    message:
      "Fest: that identity token is not valid (unknown, revoked, or expired). " +
      "Ask an admin for a new one, then update whichever of ANTHROPIC_BASE_URL or " +
      "ANTHROPIC_AUTH_TOKEN you set it in.",
  };
}

/**
 * Key posture, identity fine, but nothing can pay for the request.
 *
 * This is an OPERATOR problem surfacing to a developer, so the message says so
 * explicitly. Otherwise the developer spends their afternoon re-checking their
 * own token, which is the one thing here that is not wrong.
 */
export function noUpstreamCredential(model: string | null): AuthFailure {
  const what = model === null ? "this model" : model;
  return {
    // NOT 401. A 401 invites the client's token-refresh-and-retry path, and
    // nothing about refreshing a token fixes "the server has no credential
    // configured" — the developer just waits through ten escalating retries to
    // be told what was true at the first attempt.
    status: 400,
    type: "invalid_request_error",
    retryable: false,
    // First sentence carries it: the message is truncated in the client.
    message:
      `Fest has no credential configured for ${what} — pick a different model, or ask whoever runs Fest to add a route for it. ` +
      `(Your identity token is fine; this is a server configuration problem. ` +
      `To use your own Claude subscription instead, unset ANTHROPIC_AUTH_TOKEN and set ANTHROPIC_BASE_URL=<fest>/t/<your-token>.)`,
  };
}

/** Subscription posture with no bearer — rare, and usually a stale login. */
export function noSubscriptionCredential(): AuthFailure {
  return {
    status: 401,
    type: "authentication_error",
    retryable: false,
    message:
      "Fest: no Claude credential arrived with this request. Run `claude /login` to refresh your " +
      `subscription, and check your environment. ${DO_NOT_SET}`,
  };
}
