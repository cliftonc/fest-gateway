/**
 * `GET /api/live` — server-sent events for the dashboard's live feed.
 *
 * Subscribes to the flush-time bus, so nothing here can ever run on a
 * developer's request path. See `ingest/live-bus.ts` for why that seam exists.
 *
 * Backpressure: a browser tab that stops reading makes the kernel socket buffer
 * fill, and `res.write` starts queueing in userspace. Rather than let that grow,
 * the subscriber refuses a frame once `writableLength` exceeds a modest high
 * water mark and returns false, which the bus counts as a drop. A dashboard
 * that falls behind loses the tail of its live view and keeps its authoritative
 * history in `/api/requests` — that trade is the right way round.
 *
 * The anti-buffering headers are the same set the proxy path uses; without them
 * a reverse proxy will happily hold these frames for a minute and the feed will
 * look broken in exactly the deployment where you cannot debug it.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { LiveFrame, LiveRowWire } from "../../shared/api.ts";
import type { UsageRecord } from "../../shared/types.ts";
import type { LiveBus } from "../ingest/live-bus.ts";

/** Beyond this many bytes pending, the client is not keeping up. */
const HIGH_WATER_MARK = 1 << 20;
const HEARTBEAT_MS = 20_000;

/**
 * Project a usage record onto the feed row the dashboard renders.
 *
 * Explicit field-by-field, not a spread: `UsageRecord` carries fields the
 * dashboard has no business seeing (`callerFingerprint`, `tokenId`,
 * `errorMessage`, upstream ids), and a spread would ship every future field
 * added to the record straight to the browser. Enumerating them means a new
 * record field is invisible until someone decides it should be visible.
 */
export function toLiveRow(rec: UsageRecord): LiveRowWire {
  return {
    seq: null,
    id: rec.id,
    startedAt: rec.startedAt,
    userId: rec.userId,
    sessionId: rec.sessionId,
    requestedModel: rec.requestedModel,
    servedModel: rec.servedModel,
    posture: rec.posture,
    credentialOrigin: rec.credentialOrigin,
    credentialFingerprint: rec.credentialFingerprint,
    status: rec.status,
    httpStatus: rec.httpStatus,
    errorType: rec.errorType ?? null,
    stream: rec.stream,
    partial: rec.partial,
    usage: rec.usage,
    costUsd: rec.costUsd,
    costBasis: rec.costBasis,
    ttfbMs: rec.ttfbMs,
    durationMs: rec.durationMs,
    rl5hUtilization: rec.rateLimit?.fiveHourUtilization ?? null,
    rlClaim: rec.rateLimit?.representativeClaim ?? null,
    clientVersion: rec.clientVersion,
  };
}

export function handleLive(req: IncomingMessage, res: ServerResponse, bus: LiveBus): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.flushHeaders();
  // An immediate comment gives EventSource something to see, so the browser
  // reports "open" rather than sitting in "connecting" until the first request
  // happens to arrive — which on a quiet gateway could be hours.
  res.write(": connected\n\n");

  const unsubscribe = bus.subscribe((records) => {
    if (res.writableEnded) return false;
    if (res.writableLength > HIGH_WATER_MARK) return false;
    const frame: LiveFrame = { rows: records.map(toLiveRow) };
    res.write(`event: usage\ndata: ${JSON.stringify(frame)}\n\n`);
    return true;
  });

  // Proxies and load balancers close idle connections; a comment costs three
  // bytes and keeps the stream alive through them.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const close = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  res.on("close", close);
  req.on("aborted", close);
}
