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
    "Anthropic beta flags forwarded, except the OAuth one",
  ],
};

/**
 * Fest's adapter id → litellm's provider key, for price lookup.
 *
 * Needed because a substitute route sends a provider-native model id
 * (`accounts/fireworks/models/deepseek-v4-pro`) that is ambiguous on its own —
 * litellm files it under `fireworks_ai/accounts/fireworks/models/deepseek-v4-pro`.
 *
 * A new adapter that forgets to add a line here prices its traffic as unknown
 * rather than as some other vendor's rate. That is the correct failure: an
 * "n/a" on the dashboard is a question someone asks, and a wrong dollar figure
 * is one nobody does.
 */
export const ADAPTER_PRICE_PROVIDERS: Readonly<Record<AdapterId, string>> = {
  fireworks: "fireworks_ai",
  anthropic: "anthropic",
};
