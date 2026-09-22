/**
 * litellm's price file, normalised into Fest's rate shape.
 *
 * This module is the ONLY place that knows litellm's JSON schema. Both the
 * offline sync tool (`tools/prices-sync.ts`) and the runtime refresh
 * (`refresh.ts`) go through `normaliseCatalog`, so the vendored snapshot and a
 * freshly fetched file can never be two different formats.
 *
 * Why normalise at all rather than ship litellm's file verbatim:
 *
 *  - litellm prices PER TOKEN in floats like `5e-7`. Fest prices per million,
 *    because that is how vendors publish and how a human checks the number.
 *    Converting once at build time keeps float noise out of the hot path.
 *  - The raw file is 2.9MB and mostly fields Fest will never read (image,
 *    audio, video, batch, OCR, embedding rates). Filtering to chat models and
 *    the five token buckets Fest actually meters takes it to ~700KB, and ~48KB
 *    gzipped — small enough to vendor.
 *  - Tier suffixes are encoded in KEY NAMES (`input_cost_per_token_above_200k_tokens`),
 *    with thresholds that vary by model: 128k, 200k, 256k, 272k, 512k all
 *    appear. Discovering them by parsing the suffix is the only thing that
 *    doesn't rot; a hardcoded 200k silently understates every other model.
 */

/** Rates for one pricing tier. USD per million tokens. */
export interface TierRates {
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWrite5mPerMillion: number;
  readonly cacheWrite1hPerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelRate {
  /** The catalog key this was found under — shown in the UI as the rate label. */
  readonly label: string;
  /** litellm's provider id, e.g. `anthropic`, `fireworks_ai`. */
  readonly provider: string;
  readonly base: TierRates;
  /**
   * Long-context tiers, ascending by threshold. A call whose context exceeds a
   * threshold prices entirely at that tier's rates — vendors bill the whole
   * request at the higher rate, not just the tokens past the line.
   */
  readonly tiers: ReadonlyArray<{ readonly aboveTokens: number; readonly rates: TierRates }>;
  /** Rates when the provider reports the `priority` service tier. */
  readonly priority: TierRates | null;
  /** USD per 1000 web searches, when the model publishes a rate. */
  readonly webSearchPerThousand: number | null;
  /**
   * False when the provider publishes no cache rates and the cache buckets are
   * therefore priced as ordinary input. See `tierFrom` for why that is the
   * honest default rather than zero.
   */
  readonly cacheRatesPublished: boolean;
}

export interface PriceCatalog {
  readonly source: string;
  readonly fetchedAt: number;
  readonly models: Readonly<Record<string, ModelRate>>;
}

export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const PER_MILLION = 1_000_000;

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * Build one tier from a suffixed family of litellm keys.
 *
 * Returns null unless BOTH input and output are published — a tier with only
 * half its rates would price every call short, which is exactly the silent
 * undercount this codebase treats as the worst failure mode.
 *
 * The cache fallbacks are deliberate and worth stating plainly: when a provider
 * publishes no cache rate, cached tokens are billed as ordinary input, so the
 * input rate is the correct fallback. Zero would claim cache reads are free,
 * and Anthropic's ×0.1 / ×1.25 / ×2.0 multipliers are an *Anthropic* policy —
 * applying them to Fireworks would be inventing a discount nobody offers.
 */
function tierFrom(
  entry: Record<string, unknown>,
  suffix: string,
): { rates: TierRates; cachePublished: boolean } | null {
  const input = numeric(entry[`input_cost_per_token${suffix}`]);
  const output = numeric(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;

  const cacheRead = numeric(entry[`cache_read_input_token_cost${suffix}`]);
  const write5m = numeric(entry[`cache_creation_input_token_cost${suffix}`]);
  // Anthropic spells the 1h variant with `_above_1hr` BEFORE the tier suffix.
  const write1h =
    numeric(entry[`cache_creation_input_token_cost_above_1hr${suffix}`]) ??
    numeric(entry[`cache_creation_input_token_cost_above_1hr`]);

  return {
    cachePublished: cacheRead !== null || write5m !== null,
    rates: {
      inputPerMillion: input * PER_MILLION,
      outputPerMillion: output * PER_MILLION,
      cacheReadPerMillion: (cacheRead ?? input) * PER_MILLION,
      cacheWrite5mPerMillion: (write5m ?? input) * PER_MILLION,
      cacheWrite1hPerMillion: (write1h ?? write5m ?? input) * PER_MILLION,
    },
  };
}

/** `input_cost_per_token_above_200k_tokens` → 200_000. Ignores flex/priority tiers. */
const TIER_SUFFIX = /^input_cost_per_token_above_(\d+)k_tokens$/;

function tierSuffixes(entry: Record<string, unknown>): Array<{ above: number; suffix: string }> {
  const found: Array<{ above: number; suffix: string }> = [];
  for (const key of Object.keys(entry)) {
    const m = TIER_SUFFIX.exec(key);
    if (m?.[1] === undefined) continue;
    found.push({ above: Number(m[1]) * 1000, suffix: `_above_${m[1]}k_tokens` });
  }
  return found.sort((a, b) => a.above - b.above);
}

/**
 * Web search, normalised to USD per thousand queries to match how Fest counts
 * `usage.webSearches`. litellm publishes it per query, keyed by context size;
 * Fest cannot know which size was requested, so it takes the medium rate as the
 * representative one and falls back to whichever is present.
 */
function webSearchPerThousand(entry: Record<string, unknown>): number | null {
  const raw = entry["search_context_cost_per_query"];
  if (raw === null || typeof raw !== "object") return null;
  const sizes = raw as Record<string, unknown>;
  const perQuery =
    numeric(sizes["search_context_size_medium"]) ??
    numeric(sizes["search_context_size_low"]) ??
    numeric(sizes["search_context_size_high"]);
  return perQuery === null ? null : perQuery * 1000;
}

/**
 * Filter litellm's raw file down to priceable chat models.
 *
 * Non-chat modes (embedding, image, audio, rerank) are dropped: Fest meters
 * `/v1/messages` and nothing else, so an image model's per-pixel rate is weight
 * with no reader. A chat model with no usable base tier is dropped too —
 * carrying an entry we cannot price would turn an honest "unknown model" into a
 * confident zero.
 */
export function normaliseCatalog(raw: unknown, opts: { source: string; fetchedAt: number }): PriceCatalog {
  if (raw === null || typeof raw !== "object") {
    throw new Error("price catalog is not an object");
  }

  const models: Record<string, ModelRate> = {};

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // litellm carries a `sample_spec` pseudo-entry documenting its own schema.
    if (key === "sample_spec" || value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry["mode"] !== "chat") continue;

    const base = tierFrom(entry, "");
    if (base === null) continue;

    const provider = typeof entry["litellm_provider"] === "string" ? entry["litellm_provider"] : "";

    const tiers: Array<{ aboveTokens: number; rates: TierRates }> = [];
    for (const { above, suffix } of tierSuffixes(entry)) {
      const t = tierFrom(entry, suffix);
      if (t !== null) tiers.push({ aboveTokens: above, rates: t.rates });
    }

    models[key] = {
      label: key,
      provider,
      base: base.rates,
      tiers,
      priority: tierFrom(entry, "_priority")?.rates ?? null,
      webSearchPerThousand: webSearchPerThousand(entry),
      cacheRatesPublished: base.cachePublished,
    };
  }

  if (Object.keys(models).length === 0) {
    throw new Error("price catalog contained no priceable chat models");
  }

  return { source: opts.source, fetchedAt: opts.fetchedAt, models };
}
