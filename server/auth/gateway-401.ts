/**
 * The message a developer sees when Fest cannot serve them.
 *
 * This is genuinely UI: Claude Code renders `error.message` verbatim, mid-task,
 * to someone who was trying to get work done. A 401 that says "unauthorized" is
 * a support ticket. A 401 that says which variable to set is a fix.
 *
 * The messages differ by POSTURE because the remedies are opposite, and telling
 * a subscription user to set `ANTHROPIC_AUTH_TOKEN` would be actively harmful —
 * that variable is exactly what disables their subscription.
 */

export interface AuthFailure {
  readonly status: number;
  readonly type: "authentication_error";
  readonly message: string;
}

const DO_NOT_SET =
  "Do not set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN alongside it: either one makes " +
  "Claude Code stop using your Claude subscription and bill an API key instead.";

/** No identity token at all, on a deployment that requires one. */
export function noIdentity(baseUrl: string): AuthFailure {
  return {
    status: 401,
    type: "authentication_error",
    message:
      `Fest: no identity token, so this request cannot be attributed to anyone.\n` +
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
  return {
    status: 401,
    type: "authentication_error",
    message:
      `Fest: your identity is valid, but this gateway has no credential to serve ` +
      `${model === null ? "this request" : JSON.stringify(model)} with.\n` +
      `This is a server configuration problem, not a problem with your token — tell whoever runs Fest.\n` +
      `They need either a route for this model with a server-held credential, or you need to use ` +
      `your own Claude subscription: unset ANTHROPIC_AUTH_TOKEN and set ` +
      `ANTHROPIC_BASE_URL=<fest>/t/<your-token> instead.`,
  };
}

/** Subscription posture with no bearer — rare, and usually a stale login. */
export function noSubscriptionCredential(): AuthFailure {
  return {
    status: 401,
    type: "authentication_error",
    message:
      "Fest: no Claude credential arrived with this request. Run `claude /login` to refresh your " +
      `subscription, and check your environment. ${DO_NOT_SET}`,
  };
}
