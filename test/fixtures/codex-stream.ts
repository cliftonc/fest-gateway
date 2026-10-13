/**
 * Shared test fixture: a Codex Responses API stream, shaped like the one
 * codex-cli 0.162.1 received from chatgpt.com through the capture server
 * (October 2026) — same event sequence, same `event:` lines, same usage object
 * including the per-item `attribution` map — with the content replaced.
 *
 * Two properties of the real stream matter here and are kept:
 *  - `response.created` echoes the whole response with `usage: null`, so an
 *    accumulator that parsed it would see "no usage" before the real figure;
 *  - `response.completed` reports `input_tokens` INCLUDING `cached_tokens`,
 *    which Fest must split into its disjoint buckets.
 */

/** Expected usage for CODEX_STREAM after the split into Fest's buckets. */
export const EXPECTED = {
  // 15896 input − 15616 cached − 64 written
  inputTokens: 216,
  cacheReadTokens: 15616,
  cacheWrite5mTokens: 64,
  cacheWrite1hTokens: 0,
  outputTokens: 70,
  webSearches: 0,
} as const;

const RESPONSE_ID = "resp_0c8250a365f04f10016acde159f82887d2998050c2d9a37e22";
const ITEM_ID = "msg_0c8250a365f04f10016acde15e4a2087d2af8b57148c733e70";

const echoed = {
  id: RESPONSE_ID,
  object: "response",
  created_at: 1791877460,
  status: "in_progress",
  model: "gpt-6-astra",
  // The real echo carries ~30KB of instructions and tool schemas here.
  instructions: "You are Codex, a coding agent. → é 🔥",
  output: [],
  usage: null,
};

const usage = {
  input_tokens: 15896,
  input_tokens_details: { cached_tokens: 15616, cache_write_tokens: 64 },
  output_tokens: 70,
  output_tokens_details: { reasoning_tokens: 54 },
  total_tokens: 15966,
  attribution: {
    items: {
      [ITEM_ID]: { input_tokens: 2, cached_tokens: 0, cache_write_tokens: 0, output_tokens: 16 },
    },
  },
};

const ev = (type: string, data: Record<string, unknown>): string =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}`;

const EVENTS: string[] = [
  ev("response.created", { sequence_number: 0, response: echoed }),
  ev("response.in_progress", { sequence_number: 1, response: echoed }),
  ev("response.output_item.added", {
    sequence_number: 2,
    output_index: 0,
    item: { type: "message", id: ITEM_ID, status: "in_progress", content: [] },
  }),
  ev("response.output_text.delta", { sequence_number: 3, item_id: ITEM_ID, delta: "3 entr" }),
  ev("response.output_text.delta", { sequence_number: 4, item_id: ITEM_ID, delta: "ies → ok" }),
  ev("response.output_text.done", { sequence_number: 5, item_id: ITEM_ID, text: "3 entries → ok" }),
  ev("response.completed", {
    sequence_number: 6,
    response: { ...echoed, status: "completed", usage },
  }),
];

export const CODEX_STREAM: string = EVENTS.map((e) => `${e}\n\n`).join("");
