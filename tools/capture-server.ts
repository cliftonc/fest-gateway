/**
 * Fest Phase 0 — capture server. THROWAWAY DIAGNOSTIC, not shipped code.
 *
 * Answers the question the whole project depends on: what auth material does
 * Claude Code actually send to a custom ANTHROPIC_BASE_URL, and does Anthropic
 * accept it when relayed?
 *
 * Two modes:
 *   MODE=observe (default)  respond 501, never touch Anthropic. Proves what is SENT.
 *   MODE=forward            relay bytes verbatim to Anthropic. Proves what is ACCEPTED.
 *
 * Safety: credential values are never printed or written. Each is reduced to a
 * kind label plus a sha256 prefix, so runs can be correlated without holding
 * the secret. Request bodies are reduced to a shape summary; prompt text is
 * capped hard.
 *
 * Usage:
 *   node tools/capture-server.ts
 *   MODE=forward node tools/capture-server.ts
 *   PORT=8899 LOG=capture-a.jsonl node tools/capture-server.ts
 */

import http from "node:http";
import { appendFileSync } from "node:fs";
import {
  HOP_BY_HOP,
  SECRET_HEADERS,
  classifyCredential,
  fingerprint,
  partitionHeaders,
} from "../server/secret/fingerprint.ts";

const PORT = Number(process.env.PORT ?? 8899);
const MODE = (process.env.MODE ?? "observe") as "observe" | "forward";
const LOG = process.env.LOG ?? "capture.jsonl";
const UPSTREAM = process.env.UPSTREAM ?? "https://api.anthropic.com";
const PROMPT_PEEK = 200;

type BodyShape = Record<string, unknown>;

/** Reduce a /v1/messages body to structure. Never records full prompt text. */
function bodyShape(bytes: Buffer): BodyShape {
  if (bytes.length === 0) return { empty: true };
  let parsed: any;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (err) {
    return { unparseable: true, bytes: bytes.length, error: String(err).slice(0, 120) };
  }

  const system = parsed.system;
  const systemBlocks = Array.isArray(system) ? system : system === undefined ? [] : [system];
  const firstSystemText =
    typeof systemBlocks[0] === "string"
      ? systemBlocks[0]
      : typeof systemBlocks[0]?.text === "string"
        ? systemBlocks[0].text
        : undefined;

  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];

  return {
    bytes: bytes.length,
    model: parsed.model,
    stream: parsed.stream === true,
    max_tokens: parsed.max_tokens,
    // The leading system prompt is what Anthropic is believed to validate
    // subscription tokens against, so its exact head matters.
    system_present: system !== undefined,
    system_block_count: systemBlocks.length,
    system_head: firstSystemText?.slice(0, PROMPT_PEEK),
    // cache_control must survive a proxy verbatim or prompt caching breaks.
    system_cache_control: systemBlocks.map((b: any) => b?.cache_control?.type ?? null),
    message_count: messages.length,
    message_roles: messages.map((m: any) => m?.role),
    message_cache_control: messages.map(
      (m: any) =>
        (Array.isArray(m?.content) ? m.content : [])
          .map((c: any) => c?.cache_control?.type ?? null)
          .filter((v: unknown) => v !== null).length,
    ),
    tool_count: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    tool_names: Array.isArray(parsed.tools) ? parsed.tools.map((t: any) => t?.name).slice(0, 40) : [],
    tool_choice: parsed.tool_choice?.type,
    thinking: parsed.thinking?.type,
    metadata_keys: parsed.metadata ? Object.keys(parsed.metadata) : [],
    metadata_user_id_fp:
      typeof parsed.metadata?.user_id === "string"
        ? fingerprint(parsed.metadata.user_id)
        : undefined,
    betas: parsed.betas,
    top_level_keys: Object.keys(parsed),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

let seq = 0;

function record(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry);
  appendFileSync(LOG, line + "\n");
  console.log(line);
}

const server = http.createServer(async (req, res) => {
  const id = ++seq;
  const startedAt = Date.now();
  const url = req.url ?? "";

  // Run (d): does Claude Code preserve a path prefix like /t/<token>?
  const prefixMatch = /^\/(t|fest)\/([^/]+)(\/.*)?$/.exec(url);
  const identityFromPath = prefixMatch
    ? { carrier: prefixMatch[1], tokenFingerprint: fingerprint(prefixMatch[2] ?? ""), remainder: prefixMatch[3] ?? "/" }
    : null;

  // A path-carried identity token is a bearer. It must never reach the log, so
  // the recorded URL has it swapped for its fingerprint.
  const safeUrl = identityFromPath
    ? `/${identityFromPath.carrier}/<fp:${identityFromPath.tokenFingerprint}>${identityFromPath.remainder}`
    : url;

  const { credentials, plain: plainHeaders } = partitionHeaders(req.headers);

  const body = await readBody(req);
  const isMessages = /\/v1\/messages(\?|$)/.test(url);

  const entry: Record<string, unknown> = {
    id,
    at: new Date(startedAt).toISOString(),
    mode: MODE,
    method: req.method,
    url: safeUrl,
    identityFromPath,
    // The headline result: which credential family arrived.
    credentials,
    credentialKinds: credentials.map((c) => c.kind),
    anthropic_version: plainHeaders["anthropic-version"],
    anthropic_beta: plainHeaders["anthropic-beta"],
    user_agent: plainHeaders["user-agent"],
    accept_encoding: plainHeaders["accept-encoding"],
    headers: plainHeaders,
    body: isMessages ? bodyShape(body) : { bytes: body.length },
  };

  if (MODE === "observe") {
    record({ ...entry, outcome: "observed_501" });
    res.writeHead(501, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        type: "error",
        error: { type: "api_error", message: "fest capture-server: observe mode, request recorded, not forwarded" },
      }),
    );
    return;
  }

  // MODE=forward — relay BYTES VERBATIM. No parse/re-serialise: key order,
  // whitespace and number formatting must survive untouched, because request
  // shape is believed to be part of subscription-token validation.
  const target = new URL((identityFromPath?.remainder ?? url) || "/", UPSTREAM);
  const outHeaders = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name)) continue;
    if (name.startsWith("x-fest-")) continue; // our own identity carrier
    const v = Array.isArray(value) ? value.join(", ") : (value ?? "");
    outHeaders.set(name, v);
  }
  // Needed so we can observe the SSE stream; see plan note about verifying this
  // does not affect acceptance.
  outHeaders.set("accept-encoding", "identity");

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: outHeaders,
      body: body.length > 0 ? body : undefined,
      redirect: "error",
    });

    const respHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      respHeaders[k] = SECRET_HEADERS.has(k) ? "[redacted]" : v;
    });

    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    });
    res.socket?.setNoDelay(true);

    let bytesOut = 0;
    let firstByteMs: number | null = null;
    let errorEventSeen: string | null = null;

    if (upstream.body) {
      for await (const chunk of upstream.body as any as AsyncIterable<Uint8Array>) {
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
        bytesOut += chunk.byteLength;
        // Only peek for error events; never log content.
        const text = Buffer.from(chunk).toString("utf8");
        if (text.includes('"type":"error"') && errorEventSeen === null) {
          errorEventSeen = text.slice(0, 300);
        }
        if (!res.write(chunk)) {
          await new Promise((r) => res.once("drain", r));
        }
      }
    }
    res.end();

    record({
      ...entry,
      outcome: "forwarded",
      upstream: {
        status: upstream.status,
        requestId: upstream.headers.get("request-id") ?? upstream.headers.get("anthropic-request-id"),
        rateLimit: Object.fromEntries(
          Object.entries(respHeaders).filter(([k]) => k.startsWith("anthropic-ratelimit") || k === "retry-after"),
        ),
        contentType: upstream.headers.get("content-type"),
        headers: respHeaders,
        errorEventSeen,
      },
      timing: { ttfbMs: firstByteMs, totalMs: Date.now() - startedAt, bytesOut },
    });
  } catch (err) {
    record({ ...entry, outcome: "forward_failed", error: String(err).slice(0, 300) });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "api_error", message: "fest capture-server: upstream failed" } }),
      );
    } else {
      res.end();
    }
  }
});

// A long thinking turn must not be killed mid-stream.
server.requestTimeout = 0;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 76_000;

server.listen(PORT, "127.0.0.1", () => {
  console.error(`fest capture-server: mode=${MODE} http://127.0.0.1:${PORT} -> log=${LOG}`);
  if (MODE === "forward") console.error(`fest capture-server: forwarding verbatim to ${UPSTREAM}`);
});
