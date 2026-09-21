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

export const PAGES = ["posture", "live", "overview", "users", "models", "errors"] as const;
export type PageId = (typeof PAGES)[number];

export const PAGE_TITLES: Readonly<Record<PageId, string>> = {
  posture: "Credential posture",
  live: "Live feed",
  overview: "Overview",
  users: "Users",
  models: "Models",
  errors: "Errors",
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
  return (PAGES as readonly string[]).includes(hash) ? (hash as PageId) : "posture";
}

export const hrefFor = (page: PageId): string => `#/${page}`;
