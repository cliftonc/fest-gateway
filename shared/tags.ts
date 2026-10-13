/**
 * Request tags: free-form `key=value` pairs a client declares about its own
 * traffic (`team=platform,project=fest`), so usage can be grouped and filtered
 * by something other than who sent it.
 *
 * Tags are self-declared, like `x-fest-client`. They are labels for reporting,
 * never an input to authorisation or routing — a client that lies about its
 * project mislabels its own usage and nothing else.
 *
 * Two carriers, one format:
 *   - header  `x-fest-tags: team=platform,project=fest`
 *   - path    `/t/<tok>/~team=platform,project=fest/v1/messages`
 * The path form exists because Copilot on its own login can set a base URL but
 * no headers. Both are stripped before anything reaches upstream.
 *
 * Shared by the server (parsing what arrives) and the CLI (building what it
 * sends), so the two cannot disagree about what a valid tag is.
 */

export type Tags = Readonly<Record<string, string>>;

export const MAX_TAGS = 8;
export const MAX_TAG_VALUE_LENGTH = 64;

const KEY = /^[a-z0-9_.-]{1,32}$/;
/**
 * No `,` `=` `%` or `/` survives decoding: `,` and `=` are the separators, and
 * a `/` in a stored value would be ambiguous in the path form. Spaces are
 * allowed for human labels ("Platform team"); the URL form percent-encodes them.
 */
const VALUE = /^[A-Za-z0-9 ._:@-]+$/;

export interface TagPair {
  key: string;
  /** `""` only from {@link parseTagPairs}: the CLI's "unset this key". */
  value: string;
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * `team=platform,project=fest` → pairs, in order, duplicates kept (last wins
 * when folded). Each half is URL-decoded. Invalid pairs are dropped silently:
 * a malformed tag must never fail the request it rides on.
 *
 * An empty value is kept here (the CLI uses `project=` to suppress a default);
 * {@link parseTags} drops it.
 */
export function parseTagPairs(raw: string): TagPair[] {
  const pairs: TagPair[] = [];
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = decode(part.slice(0, eq).trim())?.trim().toLowerCase();
    const value = decode(part.slice(eq + 1).trim())?.trim();
    if (key === undefined || value === undefined) continue;
    if (!KEY.test(key)) continue;
    if (value !== "" && (value.length > MAX_TAG_VALUE_LENGTH || !VALUE.test(value))) continue;
    pairs.push({ key, value });
  }
  return pairs;
}

/**
 * Fold pairs into tags: last wins per key, and an empty value removes the key.
 * Layers merge by concatenating their pairs lowest-precedence first, so a
 * higher layer's `project=` suppresses a lower layer's `project=fest`.
 */
export function tagsFromPairs(pairs: readonly TagPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (value === "") {
      delete out[key];
      continue;
    }
    if (!(key in out) && Object.keys(out).length >= MAX_TAGS) continue;
    out[key] = value;
  }
  return out;
}

export function parseTags(raw: string): Record<string, string> {
  return tagsFromPairs(parseTagPairs(raw));
}

/**
 * The one stored form: a JSON object with sorted keys, or `""` for no tags.
 *
 * Sorted, because the rollup keys on this string — `{"a":"1","b":"2"}` and
 * `{"b":"2","a":"1"}` must land in the same bucket.
 */
export function canonicalTags(tags: Tags | null | undefined): string {
  if (tags === null || tags === undefined) return "";
  const keys = Object.keys(tags).sort();
  if (keys.length === 0) return "";
  const sorted: Record<string, string> = {};
  for (const k of keys) sorted[k] = tags[k]!;
  return JSON.stringify(sorted);
}

/** Inverse of {@link canonicalTags}; anything unreadable is no tags. */
export function tagsFromCanonical(s: string | null | undefined): Record<string, string> {
  if (s === null || s === undefined || s === "") return {};
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/** `team=platform,project=fest` with each half URL-encoded — the wire form. */
export function formatTags(tags: Tags): string {
  return Object.keys(tags)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(tags[k]!)}`)
    .join(",");
}

/** The path segment, `~team=platform,project=fest`, or `""` for no tags. */
export function tagPathSegment(tags: Tags): string {
  const s = formatTags(tags);
  return s === "" ? "" : `~${s}`;
}

// ── Dashboard filter form ────────────────────────────────────────────────────
//
// The dashboard filters by `tag=key:value` query params (one per key, AND).
// `:` rather than `=` because the whole thing already sits inside a query
// string, where `=` is taken.

export type TagFilter = Readonly<Record<string, string>>;

/** `["team:platform", "project:fest"]` → filter. Invalid entries dropped. */
export function parseTagFilter(values: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of values) {
    const colon = v.indexOf(":");
    if (colon <= 0) continue;
    const key = v.slice(0, colon).trim().toLowerCase();
    const value = v.slice(colon + 1).trim();
    if (!KEY.test(key) || value === "" || value.length > MAX_TAG_VALUE_LENGTH || !VALUE.test(value)) continue;
    if (!(key in out) && Object.keys(out).length >= MAX_TAGS) continue;
    out[key] = value;
  }
  return out;
}

export function formatTagFilter(filter: TagFilter): string[] {
  return Object.keys(filter)
    .sort()
    .map((k) => `${k}:${filter[k]!}`);
}

export function isValidTagKey(key: string): boolean {
  return KEY.test(key);
}
