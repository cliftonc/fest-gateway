/**
 * Shell: navigation, the shared range control, and the page switch.
 *
 * Screen order is the value order from the plan — credential posture first,
 * because "whose credential paid for this" is the compliance question this
 * gateway exists to answer, and it is the one an admin should not have to go
 * looking for.
 */

import { useState } from "react";
import { PAGES, PAGE_TITLES, hrefFor, usePage } from "./lib/router.ts";
import { DEFAULT_RANGE_ID, RANGE_OPTIONS, rangeFor } from "./lib/range.ts";
import { PosturePage } from "./pages/Posture.tsx";
import { LivePage } from "./pages/Live.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { UsersPage } from "./pages/Users.tsx";
import { ModelsPage } from "./pages/Models.tsx";
import { ErrorsPage } from "./pages/Errors.tsx";

export function App(): React.JSX.Element {
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
        {PAGES.map((p) => (
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
      </main>
    </div>
  );
}
