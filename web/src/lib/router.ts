/**
 * A hash router in thirty lines.
 *
 * Hash routing and not history routing so the bundle works unchanged whether it
 * is served from `/`, from a sub-path, or opened as a file — the gateway may be
 * mounted anywhere and there is no server-side route table to keep in step.
 *
 * `useSyncExternalStore` rather than `useEffect` + state: it is the API built
 * for subscribing to a browser-owned value, and it cannot render a stale route
 * on first paint the way the effect version can.
 */

import { useMemo, useSyncExternalStore } from "react";
import { buildHash, globalParams, parseHash } from "./url-state.ts";

/**
 * Nav order is landing order. The live feed is first because it answers "is
 * this thing working, and what is going through it right now" without the
 * reader having to pick a question first; routing is immediately behind it
 * because "what will this gateway substitute, and what does it add" is the
 * config an operator must be able to check before traffic proves it, and it
 * should not need looking for. What it then cost, and whose credential paid,
 * is Stats.
 */
export const PAGES = ["live", "routing", "stats", "users", "models", "errors", "admin"] as const;
export type PageId = (typeof PAGES)[number];

export const PAGE_TITLES: Readonly<Record<PageId, string>> = {
  live: "Live feed",
  routing: "Routing",
  stats: "Stats",
  users: "Users",
  models: "Models",
  errors: "Errors",
  admin: "Audit log",
};

function currentPage(): string {
  return parseHash(window.location.hash).page;
}

/**
 * `replaceState` does not fire `hashchange`, so filter writes announce
 * themselves on this event instead, and every URL subscriber listens to both.
 */
const URL_EVENT = "fest:urlchange";

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  window.addEventListener(URL_EVENT, cb);
  return () => {
    window.removeEventListener("hashchange", cb);
    window.removeEventListener(URL_EVENT, cb);
  };
}

export function usePage(): PageId {
  const page = useSyncExternalStore(subscribe, currentPage, () => "");
  return (PAGES as readonly string[]).includes(page) ? (page as PageId) : "live";
}

/**
 * The filter params in the hash (see `url-state.ts`). The snapshot is the raw
 * hash STRING — stable between renders, unlike a fresh URLSearchParams — and
 * is parsed once per change.
 */
export function useUrlParams(): URLSearchParams {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return useMemo(() => parseHash(hash).params, [hash]);
}

/**
 * Rewrite the current page's params. `replaceState`, not a new history entry:
 * nudging a filter should not turn the back button into an undo stack.
 * Built from the full current URL rather than a bare `#…`, which would resolve
 * against the deployment's `<base href>` instead of this document.
 */
export function setUrlParams(update: (params: URLSearchParams) => URLSearchParams): void {
  const { page, params } = parseHash(window.location.hash);
  const next = buildHash(page === "" ? "live" : page, update(params));
  if (next === window.location.hash) return;
  const url = `${window.location.href.split("#")[0] ?? ""}${next}`;
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(URL_EVENT));
}

/**
 * A nav link that keeps the global filters (range, tags) — moving from Stats to
 * Models should not drop "project=fest". Pass the current params so the link
 * re-renders when they change.
 */
export const hrefFor = (page: PageId, current?: URLSearchParams): string =>
  buildHash(page, current === undefined ? new URLSearchParams() : globalParams(current));
