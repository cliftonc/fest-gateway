/**
 * Choose a pipeline for one request, and hand off.
 *
 * The fork lives here rather than inside either pipeline so that neither can
 * reach into the other. `passthrough.ts` has no idea routing exists;
 * `substitute.ts` has no idea a subscription exists. That separation is what
 * keeps "bytes are forwarded verbatim on the subscription path" true by
 * construction rather than by discipline.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. identity        — who is asking (both paths need this)
 *   2. body            — read as opaque bytes, inspected only via a copy
 *   3. route           — on the requested model
 *   4. credential      — resolved for the chosen route, refusing rather than
 *                        falling back
 *   5. dispatch
 *
 * Routing happens AFTER the body is read because the model id lives in the
 * body, not the URL. That is also why a request whose model cannot be read
 * stays on the pass-through path: routing a request we could not identify is
 * how traffic ends up somewhere nobody intended.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialOrigin } from "../../shared/types.ts";
import { detectInbound } from "../auth/posture.ts";
import { isSubscriptionCredential } from "../secret/fingerprint.ts";
import { readBodyBytes, isTooLarge, peekRequest } from "../http/body.ts";
import { anthropicError, statusForErrorType } from "../http/errors.ts";
import {
  resolveRoute,
  resolveWithoutCallerCredential,
  defaultAnthropicUpstream,
} from "../routes/resolve.ts";
import type { RouteTable } from "../routes/table.ts";
import { resolveCredential } from "../credentials/resolve.ts";
import type { SecretResolver } from "../credentials/provider.ts";
import { handleMessages } from "./passthrough.ts";
import type { PassthroughContext } from "./passthrough.ts";
import { handleSubstitute, refuse } from "./substitute.ts";
import { fireworksAdapter } from "../adapters/fireworks.ts";
import { anthropicAdapter } from "../adapters/anthropic.ts";
import type { Adapter } from "../adapters/index.ts";
import type { UsageSink } from "../ingest/sink.ts";
import { log } from "../log.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

const ADAPTERS: Readonly<Record<string, Adapter>> = {
  fireworks: fireworksAdapter,
  anthropic: anthropicAdapter,
};

export interface DispatchContext extends PassthroughContext {
  readonly routes: RouteTable;
  readonly secrets: SecretResolver;
  readonly sink: UsageSink;
}

export async function dispatchMessages(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: DispatchContext,
): Promise<void> {
  // The common case by far, and the one that must stay cheapest: no routing
  // config at all means there is nothing to decide, so do not read the body
  // twice or construct a decision just to discard it.
  //
  // An `anthropic` upstream counts as routing config even with no routes
  // pointing at it — it is the default destination for Anthropic models in the
  // key posture, so there IS a decision to make.
  if (ctx.routes.routes.length === 0 && defaultAnthropicUpstream(ctx.routes) === null) {
    await handleMessages(req, res, ctx);
    return;
  }

  const inbound = detectInbound(req.url ?? "/", req.headers);
  const body = await readBodyBytes(req, MAX_BODY_BYTES);
  if (isTooLarge(body)) {
    const type = "invalid_request_error";
    res.writeHead(statusForErrorType(type), { "content-type": "application/json" });
    res.end(anthropicError(type, `Fest: request body exceeds ${MAX_BODY_BYTES} bytes.`));
    return;
  }

  const peek = peekRequest(body);
  /**
   * With no caller credential there is nothing to pass through, so an Anthropic
   * model no route claims falls back to the `anthropic` upstream rather than to
   * a first-message failure. With one, routing is posture-blind as before —
   * the developer's own credential serves anything unrouted, and nothing
   * diverts it onto org spend.
   */
  const decision =
    inbound.upstreamCredential === null
      ? resolveWithoutCallerCredential(ctx.routes, peek.model)
      : resolveRoute(ctx.routes, peek.model);

  if (decision.pipeline === "passthrough") {
    // Hand the already-read bytes on rather than re-reading a consumed stream.
    await handleMessages(req, res, { ...ctx, routeId: decision.route?.id ?? null }, body);
    return;
  }

  // ── substitute ──────────────────────────────────────────────────────────────
  const resolved = ctx.resolveIdentity(inbound.identityToken);
  if (resolved !== null) ctx.touchToken?.(resolved.tokenId);

  const isSubscription =
    inbound.upstreamCredential !== null && isSubscriptionCredential(inbound.upstreamCredential);

  const credential = resolveCredential(
    decision,
    inbound.upstreamCredential === null
      ? null
      : { fingerprint: inbound.upstreamCredential.fingerprint, isSubscription },
    ctx.secrets,
  );

  const base = {
    id: randomUUID(),
    startedAt: Date.now(),
    posture: inbound.posture,
    identityCarrier: inbound.identity.carrier,
    callerFingerprint: inbound.identity.tokenFingerprint,
    userId: resolved?.userId ?? null,
    tokenId: resolved?.tokenId ?? null,
    // The credential that SERVED the request is the server's, so the inbound
    // fingerprint is not the right thing to record here. It is null rather
    // than the caller's, because recording the caller's would read as though
    // theirs was used.
    credentialFingerprint: null,
    // A server-held credential is org spend, always. This is the field the
    // posture screen keys off.
    credentialOrigin: "fallback_server" as CredentialOrigin,
    sessionId: headerValue(req, "x-claude-code-session-id"),
    clientVersion: headerValue(req, "user-agent"),
  };

  if (!credential.ok) {
    log.warn("substitute refused: no server credential", {
      route: decision.route?.id ?? null,
      upstream: decision.upstream?.id ?? null,
      model: decision.requestedModel,
    });
    refuse(res, ctx.sink, base, decision, credential.considered, credential.message);
    return;
  }

  const adapter = ADAPTERS[decision.upstream?.adapter ?? ""];
  if (adapter === undefined || credential.secret === null) {
    // Unreachable through validated config; refusing beats guessing.
    refuse(
      res,
      ctx.sink,
      base,
      decision,
      credential.considered,
      `Fest: no adapter for upstream ${JSON.stringify(decision.upstream?.id ?? "?")}.`,
    );
    return;
  }

  await handleSubstitute(req, res, {
    base,
    decision,
    adapter,
    secret: credential.secret,
    considered: credential.considered,
    body,
    path: inbound.effectivePath,
    betas: headerValue(req, "anthropic-beta"),
    stream: peek.stream,
    sink: ctx.sink,
  });
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
