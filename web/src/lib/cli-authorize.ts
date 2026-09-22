/**
 * The dashboard's half of `fest login`.
 *
 * When the CLI asks to be authorised and nobody is signed in, the gateway sends
 * the browser here with `?cli_authorize=<the CLI's loopback callback>`. The
 * dashboard shows its normal login screen, and once there is a session this
 * hands control back to the gateway's approval page.
 *
 * The target is parked in `sessionStorage` immediately, before anything can
 * navigate away, because signing in with OAuth leaves the origin entirely and
 * comes back to a bare `/` — the query string does not survive that trip.
 * `sessionStorage` does: it is per-tab and outlives navigations within the tab,
 * which is exactly the shape of this flow. It is cleared the moment it is used,
 * so a later reload cannot replay it.
 */

import { useEffect } from "react";
import { appUrl } from "./base.ts";

const KEY = "fest-cli-authorize";

/** Only ever a loopback callback: this decides where an identity token goes. */
function isLoopback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}

/**
 * Captured at module load rather than in an effect: React may not have
 * committed before a redirect, and the value must be saved before the login
 * screen's OAuth link can take the tab away.
 */
function capture(): void {
  const target = new URLSearchParams(window.location.search).get("cli_authorize");
  if (target !== null && isLoopback(target)) sessionStorage.setItem(KEY, target);
}

if (typeof window !== "undefined") capture();

export function useCliAuthorizeHandoff(authenticated: boolean): void {
  useEffect(() => {
    if (!authenticated) return;
    const target = sessionStorage.getItem(KEY);
    if (target === null) return;
    sessionStorage.removeItem(KEY);
    window.location.assign(
      appUrl(`api/auth/cli/authorize?cli_redirect_uri=${encodeURIComponent(target)}`),
    );
  }, [authenticated]);
}
