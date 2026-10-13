/**
 * Typed fetchers for the Fest JSON API.
 *
 * Types come from `shared/api.ts`, which `server/api/routes.ts` asserts its
 * responses against — so a query-layer rename breaks `tsc`, not the browser.
 *
 * No runtime validation on purpose: this is a first-party API over loopback
 * whose shape is compile-time checked at both ends, and a Zod layer here would
 * duplicate the contract in a third place where it could rot independently.
 */

import type {
  AuditResponse,
  ErrorsResponse,
  ModelsResponse,
  OverviewResponse,
  QuotaResponse,
  RequestsResponse,
  RoutingResponse,
  TagsResponse,
  UsersResponse,
} from "../../../shared/api.ts";
import { formatTagFilter, type TagFilter } from "../../../shared/tags.ts";
import { appUrl } from "./base.ts";

/**
 * What a screen is looking at: a time window and, optionally, a tag filter.
 * The tags ride on the range so every ranged call carries them without each
 * page having to remember — the server applies them the same way.
 */
export interface Range {
  readonly fromMs: number;
  readonly toMs: number;
  readonly tags?: TagFilter | undefined;
}

/** A query-key fragment for a range, tags included, so a filter change refetches. */
export const rangeKey = (r: Range): ReadonlyArray<string | number> => [
  r.fromMs,
  r.toMs,
  formatTagFilter(r.tags ?? {}).join(","),
];

export interface FeedFilters {
  readonly userId?: string | undefined;
  readonly model?: string | undefined;
  readonly credentialOrigin?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly errorsOnly?: boolean | undefined;
  readonly tags?: TagFilter | undefined;
}

async function get<T>(
  path: string,
  params: Record<string, string | readonly string[] | undefined>,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    // Repeated for a list: `tag=team:platform&tag=project:fest`.
    for (const one of typeof v === "string" ? [v] : v) if (one !== "") search.append(k, one);
  }
  const qs = search.toString();
  const res = await fetch(appUrl(`api/${path}${qs === "" ? "" : `?${qs}`}`), {
    headers: { accept: "application/json" },
  });
  if (res.status === 401) {
    // The session expired, or was signed out in another tab. Tell the shell so
    // it can show the login screen, rather than letting every panel render its
    // own "HTTP 401" and leaving the operator to guess what happened.
    window.dispatchEvent(new Event("fest:unauthenticated"));
  }
  if (!res.ok) {
    // Surface the server's own message where there is one: "no such endpoint"
    // is far more useful in a toast than "HTTP 404".
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string") detail = body.error;
    } catch {
      /* non-JSON error body; the status is all we have */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const rangeParams = (r: Range): Record<string, string | readonly string[]> => ({
  from: String(r.fromMs),
  to: String(r.toMs),
  tag: formatTagFilter(r.tags ?? {}),
});

export const api = {
  overview: (r: Range): Promise<OverviewResponse> => get("overview", rangeParams(r)),
  users: (r: Range): Promise<UsersResponse> => get("users", rangeParams(r)),
  models: (r: Range): Promise<ModelsResponse> => get("models", rangeParams(r)),
  errors: (r: Range): Promise<ErrorsResponse> => get("errors", rangeParams(r)),
  /** Tag keys/values in range (ignores the tag filter), plus a breakdown by `by`. */
  tags: (r: Range, by?: string | null): Promise<TagsResponse> =>
    get("tags", { ...rangeParams(r), by: by ?? undefined }),
  /** No range: the question is always "where does everyone stand right now". */
  quota: (): Promise<QuotaResponse> => get("quota", {}),
  /** Administrative history, not traffic. Admin and owner only. */
  audit: (): Promise<AuditResponse> => get("audit", {}),
  /** Config, not traffic — no range, and it only changes on a restart. */
  routing: (): Promise<RoutingResponse> => get("routing", {}),
  requests: (f: FeedFilters, before?: number | null): Promise<RequestsResponse> =>
    get("requests", {
      tag: formatTagFilter(f.tags ?? {}),
      userId: f.userId,
      model: f.model,
      credentialOrigin: f.credentialOrigin,
      sessionId: f.sessionId,
      errorsOnly: f.errorsOnly === true ? "1" : undefined,
      before: before === null || before === undefined ? undefined : String(before),
      limit: "50",
    }),
};
