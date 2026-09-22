/**
 * Session state for the dashboard.
 *
 * Deliberately not a context or a store: there is exactly one session, the
 * server is the only thing that knows whether it is valid, and `/api/auth/me`
 * is one cheap call. A cached copy of "am I signed in" is a copy that can be
 * wrong — and wrong in the direction of showing a shell full of empty panels
 * after the cookie expires.
 */

import type { MeResponse } from "../../../shared/api.ts";
import { appUrl } from "./base.ts";

export async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(appUrl("api/auth/me"), { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MeResponse;
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(appUrl(path), {
    method: "POST",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    // Same-origin, so the browser sends Origin, which is what the server
    // checks instead of a CSRF token.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export async function login(email: string, password: string): Promise<MeResponse> {
  const res = await post("/api/auth/login", { email, password });
  const payload = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    // The server answers "invalid email or password" for both halves on
    // purpose; passing its message straight through keeps it that way.
    throw new Error(payload?.error ?? `HTTP ${res.status}`);
  }
  return payload as unknown as MeResponse;
}

export async function logout(): Promise<void> {
  await post("/api/auth/logout");
}
