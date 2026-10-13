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
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

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
 * Largest body a compressed request may inflate to before the peek gives up.
 * The compressed body is already capped by the reader; this caps what a small
 * hostile one can expand into.
 */
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

/**
 * A decompressed COPY of a request body, for reading only. The original bytes
 * are what is forwarded: decoding is for the peek, never for the wire.
 *
 * Copilot CLI gzips its request bodies in interactive sessions (not under
 * `-p`), and a compressed body reads as no model and no stream — rows labelled
 * "unresolved", and a streamed turn buffered whole and metered at zero.
 */
function inflate(bytes: Uint8Array, contentEncoding: string | null): Uint8Array {
  const encoding = contentEncoding?.trim().toLowerCase() ?? "";
  if (encoding === "" || encoding === "identity") return bytes;
  const opts = { maxOutputLength: MAX_INFLATED_BYTES };
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return gunzipSync(bytes, opts);
    case "deflate":
      return inflateSync(bytes, opts);
    case "br":
      return brotliDecompressSync(bytes, opts);
    case "zstd":
      return zstdDecompressSync(bytes, opts);
    default:
      // Stacked or unknown codings: report less rather than guess.
      return bytes;
  }
}

/**
 * Inspect a body copy for the few fields Fest needs. Tolerant by design: a
 * body we cannot parse is still forwarded verbatim, we just report less about
 * it. Failing a request because our own telemetry could not read it would be
 * the wrong trade.
 *
 * `contentEncoding` is the request's `content-encoding`, when the caller wants
 * a compressed body read. Only the pass-through relay passes it: the routing
 * dispatcher must not learn the model of a body the substitute path could not
 * rewrite.
 */
export function peekRequest(bytes: Uint8Array, contentEncoding: string | null = null): RequestPeek {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(inflate(bytes, contentEncoding)).toString("utf8"));
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
