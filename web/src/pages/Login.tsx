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
import { Brand } from "../App.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { Label } from "../components/ui/label.tsx";

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
    <div className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-[380px] rounded-xl bg-card p-6 ring-1 ring-foreground/10">
        <div className="-mx-2.5">
          <Brand />
        </div>

        {authError !== null && (
          <p className="mt-4 text-sm text-status-bad" role="alert">
            {authError}
          </p>
        )}

        {setupRequired && (
          <p className="mt-4 text-[13px] text-muted-foreground">
            Nobody has claimed this deployment yet, so it is running open on loopback.
            {oauthProviders.length > 0
              ? " Sign in below to become its owner, or create an account from the host:"
              : " Create an owner account on the host:"}
          </p>
        )}

        {oauthProviders.length > 0 && (
          <div className="mt-4 flex flex-col gap-2">
            {oauthProviders.map((p) => (
              // Real anchors: these are full-page navigations to the OAuth
              // start endpoint, not in-app actions.
              <Button key={p} variant="outline" asChild>
                <a href={`/api/auth/oauth/${p}/start`}>Continue with {PROVIDER_LABEL[p] ?? p}</a>
              </Button>
            ))}
            {!setupRequired && (
              <p className="mt-1 text-center text-[13px] text-muted-foreground">
                or sign in with a password
              </p>
            )}
          </div>
        )}

        {setupRequired ? (
          <>
            <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs">
              fest admin create you@corp.test
            </pre>
            <p className="mt-2 text-[13px] text-muted-foreground">
              The password is printed once. Until then Fest will refuse to listen on any interface
              other than loopback.
            </p>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-2">
            <Label htmlFor="email" className="text-muted-foreground">
              Email
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <Label htmlFor="password" className="mt-2 text-muted-foreground">
              Password
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            {/* The server's message, unaltered: it says the same thing for a
                wrong password and an unknown account, which is the point. */}
            {error !== null && (
              <p className="text-sm text-status-bad" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={busy} className="mt-4">
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        )}

        <p className="mt-5 text-[11.5px] leading-relaxed text-muted-foreground">
          Accounts are created from the host with <code className="mono">fest admin create</code>.
          There is no self-registration and no email reset.
        </p>
      </div>
    </div>
  );
}
