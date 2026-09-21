/**
 * Adapter descriptions, separated from the adapters themselves.
 *
 * The API layer needs to tell an operator what an adapter changes about a
 * request, but importing `adapters/fireworks.ts` into the dashboard API would
 * drag the whole request-building path — and a live secret type — into a module
 * whose entire job is to emit JSON to a browser. This holds the descriptions
 * and nothing else.
 */

import type { AdapterId } from "../routes/table.ts";

export const ADAPTER_TRANSFORMS: Readonly<Record<AdapterId, readonly string[]>> = {
  fireworks: [
    "model id rewritten to the provider's id",
    "server-held credential substituted for the caller's",
    "Anthropic beta headers not forwarded",
  ],
  anthropic: [
    "model id rewritten to the configured id",
    "server-held API key substituted for the caller's credential",
  ],
};
