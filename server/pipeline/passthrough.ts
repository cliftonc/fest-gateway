/**
 * The pass-through pipeline: relay a request to Anthropic unchanged, and
 * observe it on the way past.
 *
 * This pipeline deliberately does NOT use a provider-adapter interface.
 * Adapters exist to transform requests; this path exists precisely not to. On
 * the subscription posture the developer's own OAuth bearer is forwarded and
 * Anthropic validates the request shape, so every byte of the body and every
 * inbound header is sacred. Keeping this as its own pipeline — rather than a
 * "no-op adapter" — is what makes that rule enforceable instead of aspirational,
 * and leaves a future routing/rewriting path free to grow without endangering
 * it.
 *
 * What Fest is allowed to do here: authenticate the caller, relay bytes, tee
 * the stream for metering, and record what happened.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  UsageRecord,
  RequestStatus,
  CredentialOrigin,
  CredentialAttempt,
} from "../../shared/types.ts";
import { EMPTY_USAGE } from "../../shared/types.ts";
import { detectInbound } from "../auth/posture.ts";
import { buildUpstreamHeaders, buildDownstreamHeaders, parseRateLimit } from "../http/headers.ts";
import { anthropicError, statusForErrorType, sseErrorEvent } from "../http/errors.ts";
import { readBodyBytes, isTooLarge, peekRequest } from "../http/body.ts";
import { createSseParser } from "../http/sse.ts";
import { createUsageAccumulator, usageFromJson } from "../usage/accumulator.ts";
import { priceUsage } from "../usage/pricing.ts";
import { pipeWithTee, beginStream } from "../http/pipe.ts";
import { isSubscriptionCredential } from "../secret/fingerprint.ts";
import type { UsageSink } from "../ingest/sink.ts";
import { log } from "../log.ts";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface PassthroughContext {
  readonly upstreamBaseUrl: string;
  readonly sink: UsageSink;
  readonly requireIdentity: boolean;
  /** Org that owns this deployment. Single-org for now, column exists regardless. */
  readonly orgId: string;
  /**
   * Resolve a presented identity token. Injected rather than imported so the
   * pipeline stays independent of the store (and testable without a database).
   */
  readonly resolveIdentity: (raw: string | null) => { tokenId: string; userId: string } | null;
  /** Coalesced last-used tracking; must not write per request. */
  readonly touchToken?: ((tokenId: string) => void) | undefined;
  /**
   * Route that chose this path, when a route explicitly kept the request on
   * pass-through. Null when no route matched and the default applied — the
   * dashboard shows those differently, because "deliberately not substituted"
   * and "nothing configured" are different operational states.
   */
  readonly routeId?: string | null | undefined;
}

function credentialOrigin(hasSubscription: boolean, hasKey: boolean): CredentialOrigin {
  if (hasSubscription) return "inbound_subscription";
  if (hasKey) return "inbound_key";
  return "none";
}

export async function handleMessages(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PassthroughContext,
  /**
   * Bytes already read from the request, when the dispatcher had to read them
   * to see the model id. The stream can only be consumed once, so re-reading
   * here would hang. Still the SAME bytes — the dispatcher inspects a copy and
   * never rewrites on this path.
   */
  preRead?: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const startedAt = Date.now();
  const id = randomUUID();
  const inbound = detectInbound(req.url ?? "/", req.headers);

  const sessionId = headerValue(req, "x-claude-code-session-id");
  const clientVersion = headerValue(req, "user-agent");

  const credentialsConsidered: readonly CredentialAttempt[] =
    inbound.upstreamCredential === null
      ? [{ source: "inbound", result: "missing", reason: "no credential on the request" }]
      : [
          {
            source: isSubscriptionCredential(inbound.upstreamCredential)
              ? "inbound_subscription"
              : "inbound_key",
            result: "used",
          },
        ];

  // Resolve identity before anything else, but note the two failure modes are
  // NOT the same:
  //   * a token was presented and did not resolve  -> always an error, because
  //     the developer believes they are attributed and they are not;
  //   * no token at all -> an error only when the deployment requires one.
  // Conflating them would let a revoked token silently degrade to
  // "unattributed" instead of telling the developer their token is dead.
  const presentedToken = inbound.identityToken;
  const resolved = ctx.resolveIdentity(presentedToken);
  if (resolved !== null) ctx.touchToken?.(resolved.tokenId);

  const finish = (partial: Partial<UsageRecord> & { status: RequestStatus }): void => {
    const rec: UsageRecord = {
      id,
      startedAt,
      endedAt: Date.now(),
      posture: inbound.posture,
      identityCarrier: inbound.identity.carrier,
      callerFingerprint: inbound.identity.tokenFingerprint,
      userId: resolved?.userId ?? null,
      tokenId: resolved?.tokenId ?? null,
      credentialFingerprint: inbound.upstreamCredential?.fingerprint ?? null,
      credentialOrigin: credentialOrigin(
        inbound.upstreamCredential !== null && isSubscriptionCredential(inbound.upstreamCredential),
        inbound.upstreamCredential !== null && !isSubscriptionCredential(inbound.upstreamCredential),
      ),
      sessionId,
      requestedModel: null,
      servedModel: null,
      upstream: ctx.upstreamBaseUrl,
      stream: false,
      httpStatus: null,
      partial: false,
      usage: EMPTY_USAGE,
      costUsd: null,
      costBasis: "none",
      ttfbMs: null,
      durationMs: Date.now() - startedAt,
      bytesIn: 0,
      bytesOut: 0,
      upstreamRequestId: null,
      rateLimit: null,
      clientVersion,
      pipeline: "passthrough",
      routeId: ctx.routeId ?? null,
      // Recorded even though this path never chooses: a record that says
      // "the caller's own subscription served this, nothing else was tried"
      // is what makes the absence of a substitution provable rather than
      // assumed.
      credentialsConsidered,
      ...partial,
    };
    // Fire and forget: metering must never delay or fail a request.
    ctx.sink.record(rec);
  };

  const denyIdentity = (message: string): void => {
    const type = "authentication_error";
    finish({ status: "identity_denied", httpStatus: statusForErrorType(type) });
    res.writeHead(statusForErrorType(type), { "content-type": "application/json" });
    // Claude Code renders error.message to the developer, so this string is
    // the user-facing UI. Write it for a human who is mid-task.
    res.end(anthropicError(type, message));
  };

  if (presentedToken !== null && resolved === null) {
    denyIdentity(
      "Fest: that identity token is not valid (unknown, revoked, or expired). " +
        "Ask an admin for a new one, then update ANTHROPIC_BASE_URL.",
    );
    return;
  }

  // Identity is separate from the upstream credential and is never forwarded.
  // Without it usage cannot be attributed, which for a team gateway defeats
  // the point — so a team deployment sets FEST_REQUIRE_IDENTITY=1.
  if (ctx.requireIdentity && resolved === null) {
    denyIdentity(
      "Fest: no identity token. Point ANTHROPIC_BASE_URL at https://<fest>/t/<your-token>, " +
        "or set ANTHROPIC_CUSTOM_HEADERS=\"X-Fest-Token: <your-token>\". " +
        "Do not set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN: either one disables your Claude subscription.",
    );
    return;
  }

  const bodyOrTooLarge = preRead ?? (await readBodyBytes(req, MAX_BODY_BYTES));
  if (isTooLarge(bodyOrTooLarge)) {
    const type = "invalid_request_error";
    finish({ status: "bad_request", httpStatus: statusForErrorType(type) });
    res.writeHead(statusForErrorType(type), { "content-type": "application/json" });
    res.end(anthropicError(type, `Fest: request body exceeds ${MAX_BODY_BYTES} bytes.`));
    return;
  }

  const body = bodyOrTooLarge;
  const peek = peekRequest(body);
  const isSubscription = inbound.upstreamCredential !== null && isSubscriptionCredential(inbound.upstreamCredential);

  const target = new URL(inbound.effectivePath, ctx.upstreamBaseUrl);
  const headers = buildUpstreamHeaders(req.headers, {
    posture: inbound.posture,
    upstreamHost: target.host,
  });

  const abort = new AbortController();
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method ?? "POST",
      headers,
      // The exact bytes we received. No parse, no re-serialise.
      body,
      signal: abort.signal,
      redirect: "error",
    });
  } catch (err) {
    // Failed before any bytes were sent, so we can still choose a status.
    const type = "api_error";
    log.warn("upstream request failed", { id, error: String(err).slice(0, 200) });
    finish({
      status: "upstream_error",
      httpStatus: statusForErrorType(type),
      requestedModel: peek.model,
      bytesIn: body.byteLength,
      errorType: type,
      errorMessage: String(err).slice(0, 200),
    });
    res.writeHead(statusForErrorType(type), { "content-type": "application/json" });
    res.end(anthropicError(type, "Fest: upstream request failed."));
    return;
  }

  const rateLimit = parseRateLimit(upstream.headers);
  const upstreamRequestId =
    upstream.headers.get("request-id") ?? upstream.headers.get("anthropic-request-id");
  const downstream = buildDownstreamHeaders(upstream.headers, { stream: peek.stream });

  const base = {
    requestedModel: peek.model,
    servedModel: peek.model,
    stream: peek.stream,
    httpStatus: upstream.status,
    bytesIn: body.byteLength,
    upstreamRequestId,
    rateLimit,
  };

  // ── non-streaming ──────────────────────────────────────────────────────────
  if (!peek.stream || !upstream.body) {
    const text = await upstream.text();
    let usage = EMPTY_USAGE;
    try {
      usage = usageFromJson(JSON.parse(text)) ?? EMPTY_USAGE;
    } catch {
      // A body we cannot read is still relayed; we just report less.
    }
    const priced = priceUsage(peek.model, usage, isSubscription);
    res.writeHead(upstream.status, downstream);
    res.end(text);
    finish({
      ...base,
      status: upstream.ok ? "ok" : "upstream_error",
      usage,
      costUsd: priced.cost,
      costBasis: priced.basis,
      bytesOut: Buffer.byteLength(text),
    });
    return;
  }

  // ── streaming ──────────────────────────────────────────────────────────────
  const parser = createSseParser();
  const acc = createUsageAccumulator();

  beginStream(res, upstream.status, downstream);

  try {
    const result = await pipeWithTee(upstream.body, res, {
      abort,
      startedAt,
      observe: (chunk) => {
        for (const event of parser.push(chunk)) acc.apply(event);
      },
    });
    for (const event of parser.flush()) acc.apply(event);

    const usage = acc.snapshot();
    const priced = priceUsage(peek.model, usage, isSubscription);
    const streamErr = acc.streamError();

    let status: RequestStatus = "ok";
    if (result.clientAborted) status = "client_abort";
    else if (streamErr) status = "stream_error";

    if (!result.clientAborted) res.end();

    finish({
      ...base,
      status,
      // Input tokens were already consumed upstream even on an abort, so the
      // partial usage is real and worth recording — just flagged as incomplete.
      partial: result.clientAborted || !result.completed,
      usage,
      costUsd: priced.cost,
      costBasis: priced.basis,
      ttfbMs: result.ttfbMs,
      bytesOut: result.bytesOut,
      ...(streamErr ? { errorType: streamErr.type, errorMessage: streamErr.message } : {}),
    });

    if (result.observerErrors > 0) {
      log.warn("metering observer errored mid-stream", { id, errors: result.observerErrors });
    }
  } catch (err) {
    // Headers are already sent, so the status cannot be changed. Synthesise a
    // terminal SSE error frame so the client sees a clean end rather than a
    // truncated stream. Never retry: partial text is already on screen.
    for (const event of parser.flush()) acc.apply(event);
    const usage = acc.snapshot();
    const priced = priceUsage(peek.model, usage, isSubscription);
    log.warn("upstream stream failed mid-flight", { id, error: String(err).slice(0, 200) });
    if (!res.writableEnded) {
      res.write(sseErrorEvent("api_error", "Fest: upstream connection closed mid-stream."));
      res.end();
    }
    finish({
      ...base,
      status: "stream_error",
      partial: true,
      usage,
      costUsd: priced.cost,
      costBasis: priced.basis,
      errorType: "api_error",
      errorMessage: String(err).slice(0, 200),
    });
  }
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (v === undefined) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}
