/**
 * Shell: the session gate, navigation, the shared range control, and the page
 * switch.
 *
 * Screen order is landing order — the live feed first, because "is this thing
 * working and what is going through it right now" is the question someone opens
 * a gateway dashboard with. Routing sits immediately behind it: "what will this
 * gateway do to my traffic — and to a model I did not ask it to touch" is
 * config rather than history, and it should not need looking for. Who actually
 * paid is on Stats, with the rest of what already happened.
 */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Moon, Sun } from "lucide-react";
import { PAGES, PAGE_TITLES, hrefFor, usePage } from "./lib/router.ts";
import { DEFAULT_RANGE_ID, RANGE_OPTIONS, rangeFor } from "./lib/range.ts";
import { useTheme } from "./lib/theme.tsx";
import { NearformMark } from "./components/NearformMark.tsx";
import { Button } from "./components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select.tsx";
import { RoutingPage } from "./pages/Routing.tsx";
import { LivePage } from "./pages/Live.tsx";
import { StatsPage } from "./pages/Stats.tsx";
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

  if (me.isPending) return <div className="p-6 text-muted-foreground">Loading…</div>;

  // A failure to reach /api/auth/me at all is the gateway being down, not a
  // sign-in problem; saying "sign in" here would send the operator to fix the
  // wrong thing.
  if (me.isError) {
    return (
      <div className="grid min-h-screen place-items-center p-6">
        <div className="w-full max-w-sm rounded-xl bg-card p-6 ring-1 ring-foreground/10">
          <Brand />
          <p className="mt-4 text-status-bad">Cannot reach the gateway: {me.error.message}</p>
        </div>
      </div>
    );
  }

  if (!me.data.authenticated) {
    return (
      <LoginPage
        setupRequired={me.data.setupRequired}
        oauthProviders={me.data.oauthProviders}
        onSignedIn={() => void queryClient.invalidateQueries()}
      />
    );
  }

  return <Dashboard user={me.data.user} onSignedOut={() => void queryClient.invalidateQueries()} />;
}

export function Brand(): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 px-2.5">
      {/* Nearform made it; Fest is what it is called. The mark is attribution,
          not the product's identity, so it stays small and quiet. */}
      <NearformMark className="mt-0.5 h-5 w-5 shrink-0 text-foreground" />
      <div className="leading-tight">
        <div className="text-[17px] font-bold tracking-[0.02em]">Fest</div>
      </div>
    </div>
  );
}

function ThemeToggle(): React.JSX.Element {
  const { theme, toggleTheme } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
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
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const range = rangeFor(rangeId);

  // The live feed is its own clock; a range picker on it would imply it shows
  // history, which it does not. Routing is config, not traffic — a range there
  // would imply the table had a past on this screen, and it does not.
  const showRange = page !== "live" && page !== "routing";

  return (
    // The shell owns the viewport and only the main panel scrolls, so the
    // identity and sign-out controls at the foot of the nav are reachable
    // without scrolling back up through a feed that is still growing.
    <div className="grid h-screen grid-cols-[210px_1fr] overflow-hidden">
      <nav className="flex flex-col gap-1 overflow-y-auto border-r bg-sidebar p-3 pt-4.5">
        <div className="pb-3.5">
          <Brand />
        </div>

        {PAGES.filter((p) => p !== "admin" || user?.role !== "member").map((p) => (
          <a
            key={p}
            href={hrefFor(p)}
            aria-current={p === page ? "page" : undefined}
            className="block rounded-md px-2.5 py-1.5 text-sidebar-foreground no-underline hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-primary aria-[current=page]:font-medium aria-[current=page]:text-sidebar-primary-foreground"
          >
            {PAGE_TITLES[p]}
          </a>
        ))}

        <div className="mt-auto p-2.5 text-[11.5px] text-muted-foreground">
          {user !== undefined && (
            <div className="mb-3 flex flex-col gap-1.5">
              <span className="truncate text-foreground" title={user.email}>
                {user.email}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setSignOutError(null);
                    void logout()
                      .then(onSignedOut)
                      .catch((e: unknown) =>
                        setSignOutError(e instanceof Error ? e.message : "sign out failed"),
                      );
                  }}
                >
                  Sign out
                </Button>
                <ThemeToggle />
              </div>
              {/* A refused sign-out used to do nothing at all, which reads as a
                  dead button rather than as the server saying no. */}
              {signOutError !== null && <span className="text-status-bad">{signOutError}</span>}
            </div>
          )}
          Metadata only — no prompts or responses are captured, and no credential is ever stored.
        </div>
      </nav>

      <main className="overflow-y-auto">
        <div className="max-w-[1400px] px-6 pt-5 pb-15">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold">{PAGE_TITLES[page]}</h1>
          {showRange && (
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="range" className="text-xs text-muted-foreground">
                Range
              </label>
              <Select value={rangeId} onValueChange={setRangeId}>
                <SelectTrigger id="range" size="sm" className="w-[150px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {page === "live" && <LivePage />}
        {page === "routing" && <RoutingPage />}
        {page === "stats" && <StatsPage range={range} />}
        {page === "users" && <UsersPage range={range} />}
        {page === "models" && <ModelsPage range={range} />}
        {page === "errors" && <ErrorsPage range={range} />}
        {page === "admin" && <AdminPage />}
        </div>
      </main>
    </div>
  );
}
