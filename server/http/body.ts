/**
 * Request body handling for a byte-for-byte proxy.
 *
 * The body is read as opaque bytes and forwarded unchanged. It is never
 * `JSON.parse`d and re-serialised, because a round-trip changes key order,
 * whitespace, unicode escaping and number formatting — and on the subscription
 * path Anthropic validates the request shape. Phase 0 showed the body even
 * carries its own attribution block inside `system[0].text`
 * (`x-anthropic-billing-header: cc_version=…`), so the payload is not ours to
 * normalise.
 *
 * To route or report on a request we still need to know the model, so we parse
 * a *copy* for inspection only. `peekRequest` is read-only by construction: it
 * returns primitives and never hands back the parsed object.
 */

import type { IncomingMessage } from "node:http";

export interface BodyTooLarge {
  readonly tooLarge: true;
}

/** Read the full body. Bodies are prompts: large, but bounded. */
export async function readBodyBytes(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | BodyTooLarge> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    total += chunk.byteLength;
    if (total > maxBytes) return { tooLarge: true };
    chunks.push(chunk);
  }

  // Assembled into a Uint8Array backed by a plain ArrayBuffer, which is what
  // `fetch` accepts as a BodyInit. `Buffer.concat` would copy just the same,
  // so this costs nothing extra and avoids an unsound cast at the fetch call —
  // where a mistake would mean sending the wrong bytes on a path whose whole
  // contract is that the bytes are unchanged.
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function isTooLarge(v: Uint8Array<ArrayBuffer> | BodyTooLarge): v is BodyTooLarge {
  return !(v instanceof Uint8Array);
}

export interface RequestPeek {
  readonly model: string | null;
  readonly stream: boolean;
  /**
   * `max_tokens`, which tells a one-token warmup ping apart from real work.
   * Null when absent or not a number — never coerced, because "asked for 1" and
   * "did not say" are different facts and only one of them identifies a ping.
   */
  readonly maxTokens: number | null;
}

/**
 * Inspect a body copy for the few fields Fest needs. Tolerant by design: a
 * body we cannot parse is still forwarded verbatim, we just report less about
 * it. Failing a request because our own telemetry could not read it would be
 * the wrong trade.
 */
export function peekRequest(bytes: Uint8Array): RequestPeek {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      return { model: null, stream: false, maxTokens: null };
    }
    const obj = parsed as Record<string, unknown>;
    const maxTokens = obj["max_tokens"];
    return {
      model: typeof obj["model"] === "string" ? obj["model"] : null,
      stream: obj["stream"] === true,
      maxTokens: typeof maxTokens === "number" && Number.isFinite(maxTokens) ? maxTokens : null,
    };
  } catch {
    return { model: null, stream: false, maxTokens: null };
  }
}
