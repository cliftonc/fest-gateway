/**
 * Join an upstream base URL to an inbound request path.
 *
 * Deliberately NOT `new URL(path, base)`. URL resolution treats a path starting
 * with `/` as absolute and throws away the base's own path, so
 *
 *   new URL("/v1/messages", "https://api.fireworks.ai/inference/")
 *     -> https://api.fireworks.ai/v1/messages          ✗ /inference is gone
 *
 * which is a 404 from the provider, at runtime, only for base URLs that carry a
 * path prefix. A mock upstream at `http://127.0.0.1:PORT` has no prefix, so this
 * is invisible to tests that do not deliberately use one. It was found by
 * pointing it at the real Fireworks endpoint.
 *
 * So: concatenate, and normalise the seam. `baseUrl` is already stripped of
 * trailing slashes when the routing table is parsed; this tolerates them anyway
 * rather than depending on that at a distance.
 */

export function joinUpstreamUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return new URL(`${base}${suffix}`);
}
