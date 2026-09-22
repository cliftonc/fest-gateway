/**
 * The sign-in screen, and the setup notice that replaces it on a deployment
 * nobody has claimed yet.
 *
 * No "forgot password" and no self-registration. Accounts are granted from the
 * host with `fest admin`, which is the right shape for a tool an operator
 * installs for their own team: a password reset by email would mean holding
 * mail credentials to run a gateway.
 */

import { useState } from "react";
import { login } from "../lib/auth.ts";

const PROVIDER_LABEL: Record<string, string> = { google: "Google", github: "GitHub" };

export function LoginPage({
  setupRequired,
  oauthProviders,
  onSignedIn,
}: {
  setupRequired: boolean;
  oauthProviders: readonly ("google" | "github")[];
  onSignedIn: () => void;
}): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The OAuth callback redirects here with `?auth_error=` on failure — this is
  // a full page navigation, so there is no in-memory state to carry it.
  const authError = new URLSearchParams(window.location.search).get("auth_error");

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand">
          Fest
          <small>self-hosted Claude Code gateway</small>
        </div>

        {authError !== null && (
          <p className="state bad" role="alert">
            {authError}
          </p>
        )}

        {setupRequired && (
          <p className="sub">
            Nobody has claimed this deployment yet, so it is running open on loopback.
            {oauthProviders.length > 0
              ? " Sign in below to become its owner, or create an account from the host:"
              : " Create an owner account on the host:"}
          </p>
        )}

        {oauthProviders.length > 0 && (
          <div className="login-oauth">
            {oauthProviders.map((p) => (
              <a key={p} className="login-oauth-button" href={`/api/auth/oauth/${p}/start`}>
                Continue with {PROVIDER_LABEL[p] ?? p}
              </a>
            ))}
            {!setupRequired && <p className="sub">or sign in with a password</p>}
          </div>
        )}

        {setupRequired ? (
          <>
            <pre className="login-cmd">fest admin create you@corp.test</pre>
            <p className="sub">
              The password is printed once. Until then Fest will refuse to listen on any interface
              other than loopback.
            </p>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {/* The server's message, unaltered: it says the same thing for a
                wrong password and an unknown account, which is the point. */}
            {error !== null && <p className="state bad" role="alert">{error}</p>}

            <button type="submit" disabled={busy}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>
        )}

        <p className="login-foot">
          Accounts are created from the host with <code>fest admin create</code>. There is no
          self-registration and no email reset.
        </p>
      </div>
    </div>
  );
}
