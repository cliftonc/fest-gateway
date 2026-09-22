/**
 * Where this dashboard is mounted, and how to address the API from there.
 *
 * Fest may be served from the root of an origin or from a path
 * (`https://host/fest`), and the same build has to work either way — so no URL
 * in this bundle may start with `/`. A literal `fetch("/api/overview")` on a
 * dashboard served from `/fest` escapes the prefix and hits the origin root,
 * which is the whole bug this module exists to prevent.
 *
 * The mount point is read from `document.baseURI`, which the `<base href>` in
 * `index.html` sets and the gateway rewrites per deployment (see
 * `server/http/static.ts`). Reading it here rather than threading config
 * through React keeps it a constant: it cannot change without a reload.
 */

/** Absolute, and always ends in `/` — so it is safe as a `URL` base. */
export const BASE_URL: string =
  typeof document === "undefined" ? "/" : new URL(".", document.baseURI).href;

/**
 * Resolve an app-relative path against the mount point.
 *
 * Accepts `api/overview` or `/api/overview` and treats them the same, because
 * the leading slash is the easy mistake to make and silently escaping the
 * prefix is a bad way to find out.
 */
export function appUrl(path: string): string {
  return new URL(path.replace(/^\/+/, ""), BASE_URL).href;
}
