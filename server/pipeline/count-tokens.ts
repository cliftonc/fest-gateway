/**
 * `POST /v1/messages/count_tokens`.
 *
 * Relayed, but deliberately NOT metered. It consumes no tokens and produces no
 * usage, so recording it would inflate request counts and drag every per-request
 * average toward zero — a dashboard that counts questions about work as work.
 *
 * It is relayed rather than answered locally because only the provider knows its
 * own tokenizer. A plausible local estimate would be worse than no answer: it
 * feeds Claude Code's context-window accounting, and a wrong number there causes
 * either premature compaction or an overflow at the worst moment.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { anthropicError } from "../http/errors.ts";
import { readBodyBytes, isTooLarge } from "../http/body.ts";
import { buildUpstreamHeaders } from "../http/headers.ts";
import type { Posture } from "../../shared/types.ts";
import { log } from "../log.ts";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function handleCountTokens(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { upstreamBaseUrl: string; path: string; posture: Posture },
): Promise<void> {
  const body = await readBodyBytes(req, MAX_BODY_BYTES);
  if (isTooLarge(body)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(anthropicError("invalid_request_error", "Fest: count_tokens body too large."));
    return;
  }

  const target = new URL(opts.path, opts.upstreamBaseUrl);
  try {
    const upstream = await fetch(target, {
      method: "POST",
      headers: buildUpstreamHeaders(req.headers, {
        posture: opts.posture,
        upstreamHost: target.host,
      }),
      body,
      redirect: "error",
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(text);
  } catch (err) {
    log.warn("count_tokens relay failed", { error: String(err).slice(0, 200) });
    // Claude Code treats a failure here as "estimate unavailable" and carries
    // on, so failing cleanly is better than failing loudly.
    res.writeHead(502, { "content-type": "application/json" });
    res.end(anthropicError("api_error", "Fest: could not reach upstream for count_tokens."));
  }
}
