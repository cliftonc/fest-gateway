/**
 * Filter state in the URL, so a refresh or a shared link reopens the same view.
 *
 * The router is hash-based (see `router.ts`), so filters live in a query string
 * INSIDE the hash: `#/stats?range=7d&tag=team:platform&tag=project:fest`. A
 * real `?query` before the `#` would be sent to the server and would not
 * survive the gateway being mounted under a path the same way.
 *
 * Pure string functions only, so they are testable from `test/` without a DOM;
 * the React side is `useUrlParams` / `setUrlParams` in `router.ts`.
 *
 * The rule this exists for: **every filter control reads and writes the URL,
 * never `useState`.** A default value is left out of the URL, so a plain link
 * stays plain.
 */

/**
 * Params that describe WHAT is being looked at rather than how one screen
 * shows it. They follow the reader from page to page; everything else (the
 * Live window, a breakdown key) stays with the page that owns it.
 */
export const GLOBAL_PARAMS: readonly string[] = ["range", "tag"];

/** `#/stats?range=7d` → `{ page: "stats", params }`. Tolerates `#stats`, `""`. */
export function parseHash(hash: string): { page: string; params: URLSearchParams } {
  const body = hash.replace(/^#\/?/, "");
  const q = body.indexOf("?");
  return q === -1
    ? { page: body, params: new URLSearchParams() }
    : { page: body.slice(0, q), params: new URLSearchParams(body.slice(q + 1)) };
}

export function buildHash(page: string, params: URLSearchParams): string {
  const qs = params.toString();
  return `#/${page}${qs === "" ? "" : `?${qs}`}`;
}

/** Only the global params, for carrying onto another page's link. */
export function globalParams(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of params) if (GLOBAL_PARAMS.includes(k)) out.append(k, v);
  return out;
}

/**
 * Set `name` to `values` (a repeated param when more than one), or remove it
 * when `values` is null, empty, or exactly the default.
 */
export function withParam(
  params: URLSearchParams,
  name: string,
  values: string | readonly string[] | null,
  defaultValue?: string,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete(name);
  const list = values === null ? [] : typeof values === "string" ? [values] : values;
  const isDefault = list.length === 1 && defaultValue !== undefined && list[0] === defaultValue;
  if (!isDefault) for (const v of list) if (v !== "") next.append(name, v);
  return next;
}

/** One param, falling back to the default when absent or not in `allowed`. */
export function readParam<T extends string>(
  params: URLSearchParams,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = params.get(name);
  return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
