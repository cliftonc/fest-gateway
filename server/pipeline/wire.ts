/**
 * Wire profiles: everything the pass-through relay needs to know about the
 * API it is relaying, and nothing else.
 *
 * The relay itself — identity, the byte-for-byte forward, the tee, the record —
 * is the same for every client, which is why there is one `handleMessages`
 * rather than one per vendor. What differs is how usage is reported, what an
 * error looks like, which headers matter, and where quota lives. That is this
 * interface. It is not an adapter: nothing here may rewrite a request.
 *
 *  - `anthropic` — the Messages API. Claude Code, Bedrock mantle, and Copilot
 *    CLI in BYOK mode with `COPILOT_PROVIDER_TYPE=anthropic`.
 *  - `openai-responses` — the Responses API. Codex on an API key (`/openai`)
 *    and on a ChatGPT login (`/chatgpt`).
 *  - `openai-chat` — Chat Completions. Only Copilot's own API (`/copilot`)
 *    speaks it to Fest today.
 *
 * `/copilot` relays all three, on Copilot variants of each (see the bottom of
 * this file).
 */

import type { RateLimitSnapshot, UsagePayload } from "../../shared/types.ts";
import { USAGE_EVENT_TYPES } from "../../shared/types.ts";
import {
  anthropicError,
  openaiError,
  openaiSseErrorEvent,
  sseErrorEvent,
  type AnthropicErrorType,
} from "../http/errors.ts";
import { parseCodexRateLimit, parseRateLimit } from "../http/headers.ts";
import {
  createUsageAccumulator,
  usageFromJson,
  type UsageAccumulator,
} from "../usage/accumulator.ts";
import { CHAT_USAGE_EVENT_TYPES, chatUsageFromJson, createChatAccumulator } from "../usage/chat.ts";
import {
  createResponsesAccumulator,
  responsesUsageFromJson,
  RESPONSES_MAX_EVENT_CHARS,
  RESPONSES_USAGE_EVENT_TYPES,
} from "../usage/responses.ts";

export interface WireProfile {
  readonly id: "anthropic" | "openai-responses" | "openai-chat";
  readonly usageEventTypes: ReadonlySet<string>;
  readonly maxEventChars?: number | undefined;
  createAccumulator(): UsageAccumulator;
  usageFromJson(body: unknown): UsagePayload | null;
  /** A JSON error body in the envelope this wire's clients parse. */
  errorBody(type: AnthropicErrorType, message: string): string;
  /** A terminal in-band error frame, for an upstream that dies mid-stream. */
  sseErrorFrame(type: AnthropicErrorType, message: string): string;
  /** Whether to default `anthropic-version` when the client sent none. */
  readonly defaultAnthropicVersion: boolean;
  /** Response headers to relay beyond the common allowlist. */
  readonly downstreamAllow?: ((lowerName: string) => boolean) | undefined;
  parseRateLimit(headers: Headers): RateLimitSnapshot | null;
  upstreamRequestId(headers: Headers): string | null;
}

export const ANTHROPIC_WIRE: WireProfile = {
  id: "anthropic",
  usageEventTypes: USAGE_EVENT_TYPES,
  createAccumulator: createUsageAccumulator,
  usageFromJson,
  errorBody: anthropicError,
  sseErrorFrame: sseErrorEvent,
  defaultAnthropicVersion: true,
  parseRateLimit,
  upstreamRequestId: (h) => h.get("request-id") ?? h.get("anthropic-request-id"),
};

/**
 * Response headers a Codex client reads.
 *
 * `x-codex-turn-state` is the one that matters: Codex echoes it on its next
 * request so the backend keeps the turn on the same node, and dropping it was
 * not tested. The rest are quota and diagnostics Codex shows the developer.
 */
function codexAllow(name: string): boolean {
  return (
    name.startsWith("x-codex-") ||
    name.startsWith("x-ratelimit-") ||
    name.startsWith("openai-") ||
    name === "x-request-id" ||
    name === "x-oai-request-id" ||
    name === "x-models-etag"
  );
}

export const OPENAI_RESPONSES_WIRE: WireProfile = {
  id: "openai-responses",
  usageEventTypes: RESPONSES_USAGE_EVENT_TYPES,
  maxEventChars: RESPONSES_MAX_EVENT_CHARS,
  createAccumulator: createResponsesAccumulator,
  usageFromJson: responsesUsageFromJson,
  errorBody: openaiError,
  sseErrorFrame: openaiSseErrorEvent,
  defaultAnthropicVersion: false,
  downstreamAllow: codexAllow,
  // api.openai.com sends `x-ratelimit-*` request/token counters, which are per
  // org key and have no 5h/7d shape to map. chatgpt.com sends the Codex plan
  // windows, which do.
  parseRateLimit: parseCodexRateLimit,
  upstreamRequestId: (h) => h.get("x-request-id") ?? h.get("x-oai-request-id"),
};

/**
 * Copilot's own API, on the developer's Copilot login (`/copilot`).
 *
 * The usage events are the stock ones for each wire — captured from Copilot CLI
 * 1.0.96 against api.individual.githubcopilot.com — so the parsing is shared.
 * Two things differ from the Anthropic and OpenAI originals:
 *
 *  - Every response header is relayed except credentials and hop-by-hop ones.
 *    Copilot reads its plan quota from `x-quota-snapshot-*`, and its MCP
 *    traffic depends on `mcp-session-id`; an allowlist would be a list of the
 *    headers someone remembered. The developer is the one the response is
 *    addressed to, and `set-cookie` stays dropped by `buildDownstreamHeaders`.
 *  - No `anthropic-version` is invented for a Claude request: Copilot sends what
 *    its API expects, and the relay adds nothing.
 *
 * Quota is not parsed into the 5h/7d snapshot. Copilot's windows are monthly
 * (`x-quota-snapshot-chat: …&rem=98.5&rst=2026-11-01T00:00:00Z`), and filing
 * them under five-hour and seven-day columns would be wrong on the dashboard.
 */
const relayAll = (): boolean => true;
const copilotRequestId = (h: Headers): string | null =>
  h.get("x-github-request-id") ?? h.get("x-request-id");

export const COPILOT_ANTHROPIC_WIRE: WireProfile = {
  ...ANTHROPIC_WIRE,
  defaultAnthropicVersion: false,
  downstreamAllow: relayAll,
  parseRateLimit: () => null,
  upstreamRequestId: copilotRequestId,
};

export const COPILOT_RESPONSES_WIRE: WireProfile = {
  ...OPENAI_RESPONSES_WIRE,
  downstreamAllow: relayAll,
  parseRateLimit: () => null,
  upstreamRequestId: copilotRequestId,
};

/** A Chat Completions stream reports a failure as a bare `error` chunk. */
function chatSseErrorFrame(type: AnthropicErrorType, message: string): string {
  return `data: ${JSON.stringify({ error: { type, message } })}\n\n`;
}

export const COPILOT_CHAT_WIRE: WireProfile = {
  id: "openai-chat",
  usageEventTypes: CHAT_USAGE_EVENT_TYPES,
  createAccumulator: createChatAccumulator,
  usageFromJson: chatUsageFromJson,
  errorBody: openaiError,
  sseErrorFrame: chatSseErrorFrame,
  defaultAnthropicVersion: false,
  downstreamAllow: relayAll,
  parseRateLimit: () => null,
  upstreamRequestId: copilotRequestId,
};
