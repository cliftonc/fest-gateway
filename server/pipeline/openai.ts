/**
 * Codex, on the developer's own OpenAI credential.
 *
 * Two mounts, because Codex has two ways to pay and they reach two different
 * backends with two different credentials:
 *
 *  - `/openai` — an API key (`OPENAI_API_KEY`). Codex's provider `base_url` is
 *    `<fest>/openai/v1`; requests go to `FEST_OPENAI_BASE_URL`
 *    (`https://api.openai.com`) as `POST /v1/responses` and `GET /v1/models`.
 *    The key's owner is invoiced at list rates.
 *  - `/chatgpt` — a ChatGPT login. Codex's `base_url` is
 *    `<fest>/chatgpt/backend-api/codex` with `requires_openai_auth = true`, so
 *    it sends its own ChatGPT access token (`Authorization: Bearer eyJ…`) and
 *    `ChatGPT-Account-ID`; requests go to `FEST_CHATGPT_BASE_URL`
 *    (`https://chatgpt.com`). This is the Codex equivalent of a Claude
 *    subscription: the developer's plan pays, and Fest records notional value
 *    and the plan's 5h/7d windows. OpenAI documents this gateway pattern for
 *    ChatGPT workspaces ("Sign in with ChatGPT through a gateway").
 *
 * Both were established by pointing codex-cli 0.162.1 at the Phase 0 capture
 * server: the paths above, `session-id` for the session, an SSE stream with no
 * content-type from chatgpt.com, and `x-codex-turn-state` on every response.
 *
 * Like `/bedrock`, these are mounts rather than model sniffing, and for the
 * same reasons (see `bedrock.ts`): free to detect, impossible to misfire. And
 * like `/bedrock` they bypass the routing table — the mount means "relay on MY
 * credential", and no rule may swap a server-held key in under it.
 *
 * The credential is forwarded and forgotten. A ChatGPT access token is a
 * bearer for the developer's whole ChatGPT account, which is a reason to be
 * more careful with it than with an API key, not less: it is never stored,
 * and the log scrubber redacts JWTs.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { joinUpstreamUrl } from "../adapters/url.ts";
import { openaiError } from "../http/errors.ts";
import { buildDownstreamHeaders, buildUpstreamHeaders } from "../http/headers.ts";
import { detectInbound } from "../auth/posture.ts";
import { OPENAI_RESPONSES_WIRE } from "./wire.ts";
import { log } from "../log.ts";

export const OPENAI_MOUNT = "/openai";
export const CHATGPT_MOUNT = "/chatgpt";

/** The two Codex paths a mount relays, each relative to the mount. */
export interface CodexPaths {
  readonly responses: string;
  readonly models: string;
}

export const OPENAI_PATHS: CodexPaths = { responses: "/v1/responses", models: "/v1/models" };
export const CHATGPT_PATHS: CodexPaths = {
  responses: "/backend-api/codex/responses",
  models: "/backend-api/codex/models",
};

/**
 * Split a mount off a path, or null when it is not that mount.
 *
 * Same contract as `splitBedrockMount`: `/openai` alone is `/`, and
 * `/openaiish` is not the mount.
 */
export function splitMount(mount: string, path: string): string | null {
  if (!path.startsWith(mount)) return null;
  const rest = path.slice(mount.length);
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : null;
}

/**
 * `GET …/models` — relayed, never metered, like `count_tokens`.
 *
 * Codex fetches its model catalogue here before the first turn and caches it
 * against `x-models-etag`, so the etag (and `If-None-Match` on the way up) has
 * to survive. The body is relayed whole: on chatgpt.com it is ~600KB, which is
 * a one-off per session and not worth streaming code for.
 */
export async function handleCodexModels(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { upstreamBaseUrl: string; path: string },
): Promise<void> {
  const inbound = detectInbound(req.url ?? "/", req.headers);
  const target = joinUpstreamUrl(opts.upstreamBaseUrl, opts.path);
  try {
    const upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers: buildUpstreamHeaders(req.headers, {
        posture: inbound.posture,
        upstreamHost: target.host,
        defaultAnthropicVersion: false,
      }),
      redirect: "error",
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = buildDownstreamHeaders(upstream.headers, {
      stream: false,
      allow: (name) => OPENAI_RESPONSES_WIRE.downstreamAllow?.(name) === true || name === "etag",
    });
    res.writeHead(upstream.status, headers);
    res.end(body);
  } catch (err) {
    log.warn("codex models relay failed", { error: String(err).slice(0, 200) });
    res.writeHead(502, { "content-type": "application/json" });
    res.end(openaiError("api_error", "Fest: could not reach upstream for the model list."));
  }
}

/** Refuse a mount whose upstream an operator switched off. Also used by `/copilot`. */
export function refuseDisabled(res: ServerResponse, envVar: string): void {
  res.writeHead(501, { "content-type": "application/json", "x-should-retry": "false" });
  res.end(
    openaiError(
      "invalid_request_error",
      `Fest: this gateway does not relay this backend (${envVar} is set to "off").`,
    ),
  );
}
