/**
 * Copilot CLI, on the developer's own Copilot login.
 *
 * Copilot CLI sends its model traffic to GitHub's Copilot API, at the host its
 * `copilot_internal/user` response names for the account's plan:
 * `api.individual.githubcopilot.com`, `api.business.…`, `api.enterprise.…`.
 * Its `COPILOT_API_URL` override replaces that host, and `fest copilot` points
 * it at `<fest>/t/<token>/copilot/<plan>`. The plan is in the path because the
 * gateway serves every developer and each one's plan picks a different host;
 * the path is also what keeps this from being an open relay — the upstream is
 * one of three GitHub hosts, never something a caller names.
 *
 * What arrives, captured from Copilot CLI 1.0.96 (October 2026):
 *
 *  - `GET /models`, `POST /auto` (model routing), then the turn itself on one
 *    of three wires, chosen per model: `POST /v1/messages` (Claude),
 *    `POST /responses` (GPT-5 and later), `POST /chat/completions` (the rest).
 *    The turn is metered; everything else under the mount is relayed as is.
 *  - It first tries the Responses call as a WebSocket upgrade, and falls back
 *    to HTTP when the upgrade is refused. Fest refuses it (Node destroys an
 *    upgrade socket nobody listens for), so every turn is plain HTTP SSE.
 *  - `Authorization: Bearer gho_…` on everything: the GitHub OAuth token of
 *    Copilot's own login, with no exchange for a short-lived Copilot token.
 *  - The built-in GitHub MCP server's calls go to `<origin>/mcp/readonly`,
 *    dropping the API URL's path — and with it the identity token and the
 *    plan. They are relayed from the root by `relayCopilotMcp`, unmetered and
 *    unattributed, to the one host GitHub serves that server from.
 *
 * ── The GitHub token ─────────────────────────────────────────────────────────
 *
 * It is forwarded and forgotten, under the same rules as every other relayed
 * credential, and it is a broader credential than a model key — it can act on
 * the developer's GitHub account — so it is worth stating where it goes:
 *
 *  - upstream, in the `Authorization` header it arrived in, and nowhere else;
 *  - into a 12-hex-character SHA-256 fingerprint on the request row, the same
 *    non-reversible correlation id every credential gets;
 *  - never into a log line (`redactSecrets` knows `gh[opsu]_` and
 *    `github_pat_`), an error message, the store, or the live feed.
 *
 * `test/copilot-http.test.ts` checks all of that against the real writer, by
 * scanning the SQLite files and the captured log output for the token.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { joinUpstreamUrl } from "../adapters/url.ts";
import { detectInbound } from "../auth/posture.ts";
import { readBodyBytes, isTooLarge } from "../http/body.ts";
import { openaiError } from "../http/errors.ts";
import { buildDownstreamHeaders, buildUpstreamHeaders } from "../http/headers.ts";
import { log } from "../log.ts";
import { handleMessages, type PassthroughContext } from "./passthrough.ts";
import {
  COPILOT_ANTHROPIC_WIRE,
  COPILOT_CHAT_WIRE,
  COPILOT_RESPONSES_WIRE,
  type WireProfile,
} from "./wire.ts";

export const COPILOT_MOUNT = "/copilot";

/** The plans GitHub serves from their own API host. */
export const COPILOT_PLANS = ["individual", "business", "enterprise"] as const;
export type CopilotPlan = (typeof COPILOT_PLANS)[number];

const MAX_BODY_BYTES = 32 * 1024 * 1024;

function pathnameOf(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Split `/copilot/<plan>/<rest>` into its plan and the path to relay.
 *
 * Returns null when the path is not under the mount at all, and `plan: null`
 * when it is but the plan segment is not one GitHub serves. `rest` keeps the
 * query string.
 */
export function splitCopilotMount(
  remainder: string,
): { plan: CopilotPlan | null; rest: string } | null {
  if (remainder !== COPILOT_MOUNT && !remainder.startsWith(`${COPILOT_MOUNT}/`) && !remainder.startsWith(`${COPILOT_MOUNT}?`)) {
    return null;
  }
  const after = remainder.slice(COPILOT_MOUNT.length + 1);
  const cut = after.search(/[/?]/);
  const segment = cut === -1 ? after : after.slice(0, cut);
  const rest = cut === -1 ? "/" : after.slice(cut);
  const plan = (COPILOT_PLANS as readonly string[]).includes(segment) ? (segment as CopilotPlan) : null;
  return { plan, rest: rest.startsWith("?") ? `/${rest}` : rest };
}

/** The upstream for one plan: the configured template with `{plan}` filled in. */
export function copilotUpstream(template: string, plan: CopilotPlan): string {
  return template.replaceAll("{plan}", plan);
}

/** The wire a request is metered on, or null when it is not a model call. */
export function copilotWire(method: string, restPath: string): WireProfile | null {
  if (method !== "POST") return null;
  if (restPath === "/v1/messages") return COPILOT_ANTHROPIC_WIRE;
  if (restPath === "/chat/completions") return COPILOT_CHAT_WIRE;
  // `/responses/compact` and anything else beneath it bills as model work.
  if (restPath === "/responses" || restPath.startsWith("/responses/")) return COPILOT_RESPONSES_WIRE;
  return null;
}

/**
 * Who is calling, checked before anything is relayed.
 *
 * The same two failure modes as `handleMessages`, with Copilot's remedy in the
 * message rather than Claude Code's: Copilot shows `error.message` too, and a
 * sentence about `ANTHROPIC_BASE_URL` would send the developer the wrong way.
 * Returns false when it has already answered.
 */
function admit(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Pick<PassthroughContext, "resolveIdentity" | "touchToken" | "requireIdentity">,
): boolean {
  const inbound = detectInbound(req.url ?? "/", req.headers);
  const resolved = ctx.resolveIdentity(inbound.identityToken);
  if (resolved !== null) {
    ctx.touchToken?.(resolved.tokenId);
    return true;
  }
  const deny = (message: string): false => {
    res.writeHead(401, { "content-type": "application/json", "x-should-retry": "false" });
    res.end(openaiError("authentication_error", message));
    return false;
  };
  if (inbound.identityToken !== null) {
    return deny("Fest: your identity token is not valid (unknown, revoked, or expired). Run `fest login`, then `fest copilot` again.");
  }
  if (ctx.requireIdentity) {
    return deny("Fest: this gateway needs to know who you are. Run `fest login`, then start Copilot with `fest copilot`.");
  }
  return true;
}

/**
 * Relay one request as is: body in, status, headers and body out, streamed.
 *
 * For everything that is not a model call — the model list, `/auto`, the MCP
 * server. Nothing is recorded: none of it uses tokens, and a row per model-list
 * fetch would drag every per-request average toward zero, which is the reason
 * `count_tokens` is not recorded either.
 */
async function relay(req: IncomingMessage, res: ServerResponse, target: URL): Promise<void> {
  const method = req.method ?? "GET";
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const read = await readBodyBytes(req, MAX_BODY_BYTES);
    if (isTooLarge(read)) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(openaiError("invalid_request_error", `Fest: request body exceeds ${MAX_BODY_BYTES} bytes.`));
      return;
    }
    body = read;
  }

  const abort = new AbortController();
  // A long-lived MCP stream must not outlive the client that asked for it.
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: buildUpstreamHeaders(req.headers, {
        posture: "subscription",
        upstreamHost: target.host,
        defaultAnthropicVersion: false,
      }),
      ...(body === undefined ? {} : { body }),
      signal: abort.signal,
      redirect: "error",
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    log.warn("copilot relay failed", { path: target.pathname, error: String(err).slice(0, 200) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(openaiError("api_error", "Fest: could not reach GitHub's Copilot API."));
    return;
  }

  const stream = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
  res.writeHead(upstream.status, buildDownstreamHeaders(upstream.headers, { stream, allow: () => true }));
  if (upstream.body === null) {
    res.end();
    return;
  }
  if (stream) res.flushHeaders();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || res.destroyed) break;
      res.write(value);
    }
    res.end();
  } catch (err) {
    if (!abort.signal.aborted) {
      log.warn("copilot relay stream failed", { path: target.pathname, error: String(err).slice(0, 200) });
    }
    if (!res.writableEnded) res.end();
  }
}

/** `/copilot/<plan>/…`: the turn metered, everything else relayed. */
export async function handleCopilot(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    ctx: PassthroughContext;
    template: string;
    plan: CopilotPlan;
    rest: string;
  },
): Promise<void> {
  if (!admit(req, res, opts.ctx)) return;
  const upstreamBaseUrl = copilotUpstream(opts.template, opts.plan);
  const wire = copilotWire(req.method ?? "GET", pathnameOf(opts.rest));
  if (wire !== null) {
    await handleMessages(req, res, {
      ...opts.ctx,
      upstreamBaseUrl,
      pathOverride: opts.rest,
      wire,
      // The Copilot API serves nothing but plan-billed traffic, as chatgpt.com
      // does for Codex; the bearer's prefix says "GitHub", not "who pays".
      subscriptionMount: true,
    });
    return;
  }
  await relay(req, res, joinUpstreamUrl(upstreamBaseUrl, opts.rest));
}

/**
 * `/mcp/…` at the root: Copilot's built-in GitHub MCP server.
 *
 * No identity check, because there is no identity to check: Copilot builds
 * this URL from the API URL's origin alone, so the `/t/<token>` segment never
 * arrives. What keeps that safe is that the upstream is fixed — this forwards
 * a caller's own credential to GitHub's MCP host and nowhere else — and that
 * nothing is recorded. An operator who would rather not relay unattributed
 * traffic sets `FEST_COPILOT_MCP_BASE_URL=off`, and `fest copilot` can switch
 * the built-in server off on the client side.
 */
export async function relayCopilotMcp(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { upstreamBaseUrl: string; path: string },
): Promise<void> {
  await relay(req, res, joinUpstreamUrl(opts.upstreamBaseUrl, opts.path));
}

/** Refuse a path under the mount whose plan segment GitHub does not serve. */
export function refuseUnknownPlan(res: ServerResponse): void {
  res.writeHead(404, { "content-type": "application/json", "x-should-retry": "false" });
  res.end(
    openaiError(
      "not_found_error",
      `Fest: unknown Copilot plan in the URL; expected /copilot/{${COPILOT_PLANS.join("|")}}/… — start Copilot with \`fest copilot\`.`,
    ),
  );
}
