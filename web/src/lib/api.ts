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
  ErrorsResponse,
  ModelsResponse,
  OverviewResponse,
  QuotaResponse,
  RequestsResponse,
  UsersResponse,
} from "../../../shared/api.ts";

export interface Range {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface FeedFilters {
  readonly userId?: string | undefined;
  readonly model?: string | undefined;
  readonly credentialOrigin?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly errorsOnly?: boolean | undefined;
}

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, v);
  }
  const qs = search.toString();
  const res = await fetch(`/api/${path}${qs === "" ? "" : `?${qs}`}`, {
    headers: { accept: "application/json" },
  });
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

const rangeParams = (r: Range): Record<string, string> => ({
  from: String(r.fromMs),
  to: String(r.toMs),
});

export const api = {
  overview: (r: Range): Promise<OverviewResponse> => get("overview", rangeParams(r)),
  users: (r: Range): Promise<UsersResponse> => get("users", rangeParams(r)),
  models: (r: Range): Promise<ModelsResponse> => get("models", rangeParams(r)),
  errors: (r: Range): Promise<ErrorsResponse> => get("errors", rangeParams(r)),
  /** No range: the question is always "where does everyone stand right now". */
  quota: (): Promise<QuotaResponse> => get("quota", {}),
  requests: (f: FeedFilters, before?: number | null): Promise<RequestsResponse> =>
    get("requests", {
      userId: f.userId,
      model: f.model,
      credentialOrigin: f.credentialOrigin,
      sessionId: f.sessionId,
      errorsOnly: f.errorsOnly === true ? "1" : undefined,
      before: before === null || before === undefined ? undefined : String(before),
      limit: "50",
    }),
};
