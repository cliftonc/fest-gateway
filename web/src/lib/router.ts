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

import { useSyncExternalStore } from "react";

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

function currentHash(): string {
  return window.location.hash.replace(/^#\/?/, "").split("?")[0] ?? "";
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function usePage(): PageId {
  const hash = useSyncExternalStore(subscribe, currentHash, () => "");
  return (PAGES as readonly string[]).includes(hash) ? (hash as PageId) : "live";
}

export const hrefFor = (page: PageId): string => `#/${page}`;
