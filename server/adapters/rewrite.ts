/**
 * Rewrite the `model` field of a request body, and nothing else.
 *
 * This is the one body edit Fest performs, and it is confined to the substitute
 * path. It is safe there and would not be on the pass-through path: an
 * Anthropic OAuth token is validated against the request shape, so a
 * parse/re-serialise round trip (which changes key order, whitespace, number
 * formatting and unicode escaping) can invalidate it. A substitute request goes
 * to a different vendor on a different credential, so no signature depends on
 * the bytes.
 *
 * The rewrite is still done surgically rather than by round-tripping the whole
 * document, for two reasons that have nothing to do with signatures:
 *
 *  1. **Prompt caching.** `cache_control` markers must survive untouched, and
 *     the cheapest way to guarantee that is to not re-serialise the parts of
 *     the body that carry them.
 *  2. **Size.** A Claude Code request is routinely megabytes of context.
 *     `JSON.parse` → mutate → `JSON.stringify` copies all of it to change
 *     twenty bytes, on the request path, for every request.
 *
 * So: find the top-level `"model"` string and splice. If anything about the
 * body is not what we expect, the ORIGINAL bytes are returned unchanged. A
 * failed rewrite must never corrupt a request — the worst acceptable outcome is
 * that the provider rejects an unknown model id with its own clear error.
 */

/**
 * Matches a top-level `"model": "..."` pair.
 *
 * Anchored to the start of the document and allowed to skip over preceding
 * members only at nesting depth zero, which is checked separately below — the
 * regex alone cannot express that, and a naive search would happily rewrite a
 * `model` key nested inside a tool definition or a message.
 */
const MODEL_KEY = /"model"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** JSON string escaping for the replacement value. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Find the offset of the top-level `"model"` key, or -1.
 *
 * Walks the document tracking string state and brace/bracket depth, so a
 * `"model"` inside a nested object, an array, or a string literal is skipped.
 * This is the difference between rewriting the request's model and silently
 * rewriting a model name a developer mentioned in a prompt.
 */
function findTopLevelModel(text: string): { start: number; end: number } | null {
  MODEL_KEY.lastIndex = 0;

  let depth = 0;
  let inString = false;
  let escaped = false;
  // Offsets at which a top-level key may begin.
  const topLevelRanges: Array<[number, number]> = [];
  let rangeStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      if (depth === 1 && ch === "{") rangeStart = i;
      continue;
    }
    if (ch === "}" || ch === "]") {
      if (depth === 1 && rangeStart !== -1) {
        topLevelRanges.push([rangeStart, i]);
        rangeStart = -1;
      }
      depth -= 1;
      continue;
    }
  }
  if (rangeStart !== -1) topLevelRanges.push([rangeStart, text.length]);

  // Re-scan only the top-level object, tracking depth so nested matches are
  // rejected rather than merely deprioritised.
  const range = topLevelRanges[0];
  if (range === undefined) return null;

  let d = 0;
  let str = false;
  let esc = false;
  for (let i = range[0]; i < range[1]; i += 1) {
    const ch = text[i];
    if (str) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') str = false;
      continue;
    }
    if (ch === "{" || ch === "[") {
      d += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      d -= 1;
      continue;
    }
    if (ch === '"') {
      // Only consider a key match when we are directly inside the root object.
      if (d === 1) {
        MODEL_KEY.lastIndex = i;
        const m = MODEL_KEY.exec(text);
        if (m !== null && m.index === i) {
          return { start: i, end: i + m[0].length };
        }
      }
      str = true;
    }
  }
  return null;
}

/**
 * Replace the top-level `model` with `servedModel`.
 *
 * Returns the input unchanged when `servedModel` is null, when the body is not
 * a JSON object, or when no top-level `model` key is present.
 */
export function rewriteModel(
  body: Uint8Array<ArrayBuffer>,
  servedModel: string | null,
): Uint8Array<ArrayBuffer> {
  if (servedModel === null || servedModel === "") return body;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    // Not UTF-8 text; nothing safe to do but pass it along.
    return body;
  }

  const found = findTopLevelModel(text);
  if (found === null) return body;

  const replaced = `${text.slice(0, found.start)}"model": ${jsonString(servedModel)}${text.slice(found.end)}`;
  return new TextEncoder().encode(replaced);
}
