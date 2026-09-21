/**
 * The substitute pipeline: serve a request from a provider that is not the
 * caller's own Anthropic subscription, on a credential the SERVER holds.
 *
 * This is the path where rewriting is allowed — and where the interesting risk
 * lives. Three invariants hold it together, and each one is a test:
 *
 *  1. **The inbound credential is never forwarded.** The request is built from
 *     scratch by the adapter; inbound headers are not copied. A developer's
 *     Anthropic bearer reaching Fireworks would be disclosing their personal
 *     credential to a third party, and the only reliable way to prevent it is
 *     to never build a request from the inbound headers at all.
 *  2. **A missing server credential refuses the request.** It does not fall
 *     back to the subscription. Succeeding on the wrong credential — or with
 *     the wrong model — is worse than a clear failure, because nobody
 *     investigates a success.
 *  3. **Every credential considered is recorded**, including the ones skipped
 *     and why.
 *
 * Usage metering is unchanged from the pass-through path, because the adapter
 * targets an Anthropic-compatible Messages endpoint: the same SSE parser and
 * the same accumulator read the same `message_start` / `message_delta` events.
 * A provider that needed a different stream shape would need its own reader —
 * see `Adapter.readUsage`.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CredentialAttempt, RequestStatus, UsageRecord } from "../../shared/types.ts";
import { EMPTY_USAGE } from "../../shared/types.ts";
import { anthropicError, statusForErrorType, sseErrorEvent } from "../http/errors.ts";
import { buildDownstreamHeaders } from "../http/headers.ts";
import { createSseParser } from "../http/sse.ts";
import { createUsageAccumulator, usageFromJson } from "../usage/accumulator.ts";
import { priceUsage } from "../usage/pricing.ts";
import { pipeWithTee, beginStream } from "../http/pipe.ts";
import { buildRecord } from "./record.ts";
import type { RecordBase } from "./record.ts";
import type { Adapter } from "../adapters/index.ts";
import type { RouteDecision } from "../routes/resolve.ts";
import type { NonPersistable } from "../secret/non-persistable.ts";
import type { UsageSink } from "../ingest/sink.ts";
import { log } from "../log.ts";

export interface SubstituteRequest {
  readonly base: Omit<RecordBase, "pipeline" | "upstream" | "routeId" | "credentialsConsidered">;
  readonly decision: RouteDecision;
  readonly adapter: Adapter;
  readonly secret: NonPersistable<string>;
  readonly considered: readonly CredentialAttempt[];
  readonly body: Uint8Array<ArrayBuffer>;
  readonly path: string;
  readonly stream: boolean;
  readonly sink: UsageSink;
}

/** Refuse a request that cannot be served, having recorded why. */
export function refuse(
  res: ServerResponse,
  sink: UsageSink,
  base: Omit<RecordBase, "pipeline" | "upstream" | "routeId" | "credentialsConsidered">,
  decision: RouteDecision,
  considered: readonly CredentialAttempt[],
  message: string,
): void {
  const type = "invalid_request_error";
  const status = statusForErrorType(type);
  sink.record(
    buildRecord(
      {
        ...base,
        pipeline: "substitute",
        upstream: decision.upstream?.baseUrl ?? "",
        routeId: decision.route?.id ?? null,
        credentialsConsidered: considered,
      },
      {
        status: "bad_request",
        httpStatus: status,
        requestedModel: decision.requestedModel,
        servedModel: null,
        errorType: type,
        errorMessage: message,
      },
    ),
  );
  res.writeHead(status, {
    "content-type": "application/json",
    // A missing server credential is not fixed by trying again. Without this
    // the client retries ten times with backoff before showing the developer a
    // message that was accurate on the first attempt.
    "x-should-retry": "false",
  });
  // Claude Code renders this to the developer mid-task, TRUNCATED, so the
  // first sentence has to carry the whole actionable point.
  res.end(anthropicError(type, message));
}

export async function handleSubstitute(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: SubstituteRequest,
): Promise<void> {
  const { decision, adapter, sink } = ctx;
  const upstream = decision.upstream;
  if (upstream === null) throw new Error("substitute pipeline reached with no upstream");

  const recordBase: RecordBase = {
    ...ctx.base,
    pipeline: "substitute",
    upstream: upstream.baseUrl,
    routeId: decision.route?.id ?? null,
    credentialsConsidered: ctx.considered,
  };

  const finish = (partial: Partial<UsageRecord> & { status: RequestStatus }): void => {
    sink.record(buildRecord(recordBase, partial));
  };

  const plan = adapter.plan({
    path: ctx.path,
    body: ctx.body,
    servedModel: decision.servedModel,
    stream: ctx.stream,
    secret: ctx.secret,
    upstream,
  });

  const base = {
    requestedModel: decision.requestedModel,
    servedModel: decision.servedModel,
    stream: ctx.stream,
    bytesIn: plan.body.byteLength,
  };

  const abort = new AbortController();
  let response: Response;
  try {
    response = await fetch(plan.url, {
      method: "POST",
      headers: plan.headers,
      body: plan.body,
      signal: abort.signal,
      redirect: "error",
    });
  } catch (err) {
    const type = "api_error";
    log.warn("substitute upstream failed", {
      id: ctx.base.id,
      upstream: upstream.id,
      route: decision.route?.id ?? null,
      error: String(err).slice(0, 200),
    });
    finish({
      ...base,
      status: "upstream_error",
      httpStatus: statusForErrorType(type),
      errorType: type,
      errorMessage: String(err).slice(0, 200),
    });
    res.writeHead(statusForErrorType(type), { "content-type": "application/json" });
    res.end(
      anthropicError(
        type,
        `Fest: upstream ${JSON.stringify(upstream.id)} could not be reached. ` +
          `This request was NOT retried against Anthropic — it would have used a different model.`,
      ),
    );
    return;
  }

  // A 401 here means the SERVER's credential is bad, which is an operator
  // problem, not a developer one. Recorded as `rejected` so the posture screen
  // can say which credential failed rather than just showing a 401.
  const considered: readonly CredentialAttempt[] =
    response.status === 401 || response.status === 403
      ? ctx.considered.map((c) =>
          c.result === "used"
            ? { ...c, result: "rejected" as const, reason: `upstream returned ${response.status}` }
            : c,
        )
      : ctx.considered;
  const withCreds: RecordBase = { ...recordBase, credentialsConsidered: considered };
  const finishWith = (partial: Partial<UsageRecord> & { status: RequestStatus }): void => {
    sink.record(buildRecord(withCreds, partial));
  };

  const downstream = buildDownstreamHeaders(response.headers, { stream: ctx.stream });
  const upstreamRequestId = response.headers.get("request-id");

  const common = { ...base, httpStatus: response.status, upstreamRequestId };

  // ── non-streaming ──────────────────────────────────────────────────────────
  if (!ctx.stream || response.body === null) {
    const text = await response.text();
    let usage = EMPTY_USAGE;
    try {
      usage =
        adapter.readUsage?.(JSON.parse(text)) ?? usageFromJson(JSON.parse(text)) ?? EMPTY_USAGE;
    } catch {
      /* relay regardless; we simply report less */
    }
    // Never `subscription` on this path: a server-held credential is real org
    // spend by definition, whatever the caller presented.
    const priced = priceUsage(decision.servedModel, usage, false);
    res.writeHead(response.status, downstream);
    res.end(text);
    finishWith({
      ...common,
      status: response.ok ? "ok" : "upstream_error",
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

  beginStream(res, response.status, downstream);

  try {
    const result = await pipeWithTee(response.body, res, {
      abort,
      startedAt: ctx.base.startedAt,
      observe: (chunk) => {
        for (const event of parser.push(chunk)) acc.apply(event);
      },
    });
    for (const event of parser.flush()) acc.apply(event);

    const usage = acc.snapshot();
    const priced = priceUsage(decision.servedModel, usage, false);
    const streamErr = acc.streamError();

    /**
     * A non-2xx upstream response is an ERROR even when the body streamed
     * cleanly.
     *
     * Missed until a real 400 came back from a provider mid-stream and was
     * recorded as `ok`: the status was derived only from client aborts and
     * in-band SSE error events, so an upstream that refuses BEFORE emitting any
     * events produced a tidy, successful-looking record. The effect is an error
     * rate that reads as zero precisely when a provider is rejecting
     * everything.
     *
     * Ordering: a client abort still wins, because the developer walking away
     * is the more specific fact about what happened.
     */
    let status: RequestStatus = response.ok ? "ok" : "upstream_error";
    if (result.clientAborted) status = "client_abort";
    else if (streamErr) status = "stream_error";

    if (!result.clientAborted) res.end();

    finishWith({
      ...common,
      status,
      partial: result.clientAborted || !result.completed,
      usage,
      costUsd: priced.cost,
      costBasis: priced.basis,
      ttfbMs: result.ttfbMs,
      bytesOut: result.bytesOut,
      ...(streamErr ? { errorType: streamErr.type, errorMessage: streamErr.message } : {}),
    });
  } catch (err) {
    for (const event of parser.flush()) acc.apply(event);
    const usage = acc.snapshot();
    const priced = priceUsage(decision.servedModel, usage, false);
    log.warn("substitute stream failed mid-flight", {
      id: ctx.base.id,
      upstream: upstream.id,
      error: String(err).slice(0, 200),
    });
    if (!res.writableEnded) {
      res.write(sseErrorEvent("api_error", "Fest: upstream connection closed mid-stream."));
      res.end();
    }
    finishWith({
      ...common,
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
