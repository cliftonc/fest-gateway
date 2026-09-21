/**
 * Shell: the session gate, navigation, the shared range control, and the page
 * switch.
 *
 * Screen order is the value order from the plan — credential posture first,
 * because "whose credential paid for this" is the compliance question this
 * gateway exists to answer, and it is the one an admin should not have to go
 * looking for.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PAGES, PAGE_TITLES, hrefFor, usePage } from "./lib/router.ts";
import { DEFAULT_RANGE_ID, RANGE_OPTIONS, rangeFor } from "./lib/range.ts";
import { PosturePage } from "./pages/Posture.tsx";
import { LivePage } from "./pages/Live.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { UsersPage } from "./pages/Users.tsx";
import { ModelsPage } from "./pages/Models.tsx";
import { ErrorsPage } from "./pages/Errors.tsx";
import { AdminPage } from "./pages/Admin.tsx";
import { LoginPage } from "./pages/Login.tsx";
import { fetchMe, logout } from "./lib/auth.ts";

export function App(): React.JSX.Element {
  const queryClient = useQueryClient();

  /**
   * The session gate. `me` is asked for once and re-asked whenever any other
   * request comes back 401 — a cookie can expire, or be signed out from another
   * tab, at any point between two polls. Without this the dashboard would sit
   * there showing six panels of "HTTP 401".
   */
  const me = useQuery({
    queryKey: ["me"],
    queryFn: fetchMe,
    refetchInterval: false,
    staleTime: Infinity,
  });

  useEffect(() => {
    const onUnauthenticated = (): void => void queryClient.invalidateQueries({ queryKey: ["me"] });
    window.addEventListener("fest:unauthenticated", onUnauthenticated);
    return () => window.removeEventListener("fest:unauthenticated", onUnauthenticated);
  }, [queryClient]);

  if (me.isPending) return <div className="state">Loading…</div>;

  // A failure to reach /api/auth/me at all is the gateway being down, not a
  // sign-in problem; saying "sign in" here would send the operator to fix the
  // wrong thing.
  if (me.isError) {
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand">Fest</div>
          <p className="state bad">Cannot reach the gateway: {me.error.message}</p>
        </div>
      </div>
    );
  }

  if (!me.data.authenticated) {
    return (
      <LoginPage
        setupRequired={me.data.setupRequired}
        onSignedIn={() => void queryClient.invalidateQueries()}
      />
    );
  }

  return <Dashboard user={me.data.user} onSignedOut={() => void queryClient.invalidateQueries()} />;
}

function Dashboard({
  user,
  onSignedOut,
}: {
  user: { email: string; role: string } | undefined;
  onSignedOut: () => void;
}): React.JSX.Element {
  const page = usePage();
  const [rangeId, setRangeId] = useState(DEFAULT_RANGE_ID);
  const range = rangeFor(rangeId);

  // The live feed is its own clock; a range picker on it would imply it shows
  // history, which it does not.
  const showRange = page !== "live";

  return (
    <div className="app">
      <nav className="side">
        <div className="brand">
          Fest
          <small>self-hosted Claude Code gateway</small>
        </div>
        {PAGES.filter((p) => p !== "admin" || user?.role !== "member").map((p) => (
          <a
            key={p}
            className="nav-link"
            href={hrefFor(p)}
            aria-current={p === page ? "page" : undefined}
          >
            {PAGE_TITLES[p]}
          </a>
        ))}
        <div className="side-foot">
          {user !== undefined && (
            <div className="whoami">
              <span title={user.email}>{user.email}</span>
              <button
                type="button"
                onClick={() => void logout().then(onSignedOut)}
              >
                Sign out
              </button>
            </div>
          )}
          Metadata only — no prompts or responses are captured, and no
          credential is ever stored.
        </div>
      </nav>

      <main className="main">
        <div className="page-head">
          <div>
            <h1>{PAGE_TITLES[page]}</h1>
          </div>
          {showRange && (
            <div className="controls">
              <label htmlFor="range">Range</label>
              <select id="range" value={rangeId} onChange={(e) => setRangeId(e.target.value)}>
                {RANGE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {page === "posture" && <PosturePage range={range} />}
        {page === "live" && <LivePage />}
        {page === "overview" && <OverviewPage range={range} />}
        {page === "users" && <UsersPage range={range} />}
        {page === "models" && <ModelsPage range={range} />}
        {page === "errors" && <ErrorsPage range={range} />}
        {page === "admin" && <AdminPage />}
      </main>
    </div>
  );
}
