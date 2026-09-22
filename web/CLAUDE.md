# web/

The dashboard: Vite + React + TanStack Query + TanStack Charts, styled with
Tailwind and shadcn/ui. The only part of this repository with an actual build
step — the server has none.

- `src/pages/` — one file per screen (Live, Routing, Stats, Users, Models,
  Errors, Admin, Login). Nav order is landing order: Live first, because "what
  is going through this thing right now" is the question someone opens a
  gateway dashboard with; Routing second, because it is pure config — what Fest
  *will* substitute and what it adds — which must be checkable before traffic
  proves it. Everything about traffic that already happened, including whose
  credential paid and each developer's rate-limit headroom, is on Stats.
- `src/components/ui/` — shadcn components, added with
  `npx shadcn@latest add <name>` from the repo root (`components.json` lives
  there, because that is where `package.json` is). They are first-party code
  once generated: edit them freely. `badge.tsx` and `alert.tsx` carry extra
  variants for Fest's status tones.
- `src/components/live/` — the live screen's aggregate widgets: the scrolling
  pulse, the ranked rollup boards, the connection indicator.
- `src/components/` — shared UI: the chart wrappers (`charts.tsx`), small
  primitives (`ui.tsx`).
- `src/lib/` — the non-visual layer: `api.ts` (fetch wrappers typed against
  `shared/api.ts`), `auth.ts` (session calls), `sse.ts` (the live feed),
  `router.ts`, `range.ts`, `format.ts`, `theme.tsx` (light/dark, class on
  `<html>`, pre-painted by an inline script in `index.html`), `colors.ts`
  (status tones resolved for the charts, which take colour values not classes).
- `src/hooks/` — `useLiveWindow` (the rolling aggregation window behind the
  Live screen) and `useAnimatedNumber`.
- `App.tsx` — the session gate (`/api/auth/me`) and the page switch. Any
  request coming back 401 invalidates the `me` query, which is what re-asks
  "am I signed in" instead of leaving stale panels on screen.

## Maintaining this

- **The Live screen is an aggregate, not a list.** It rolls a moving window up
  by model, developer and credential origin. A row per request was tried and
  removed: by the time an operator has read three rows there are twenty more,
  and the per-request detail already lives in the database for the audit trail
  to reach. Resist re-adding a feed table here.
- **Colour still only means one thing.** The `--status-*` tokens in
  `styles.css` (ok / warn / bad / info / sub) are the domain palette and are
  kept separate from shadcn's UI-role tokens on purpose. Every use is paired
  with text, because "the red one" is not information an admin can act on over
  a screen share.
- **Never import from `server/`.** Only from `shared/` and from `web/src`
  itself — the server's import graph reaches `node:sqlite`, which the
  browser bundle must never see. If a type is needed on both sides, it goes
  in `shared/`, not here.
- API calls go through `src/lib/api.ts`, typed against `shared/api.ts`'s
  wire contracts — don't `fetch()` an endpoint ad hoc from inside a page
  component; add or extend a function in `lib/api.ts` so the shape stays
  centrally typed.
- **No URL in this bundle may start with `/`.** Fest can be served from a
  path (`https://host/fest`), and a root-absolute `fetch("/api/…")`, `href`
  or `EventSource` escapes the prefix and hits the origin root instead.
  Everything goes through `appUrl()` in `src/lib/base.ts`, which resolves
  against the `<base href>` the gateway rewrites per deployment. This fails
  silently at the root and only breaks on a sub-path deployment, so it will
  not be caught by local testing.
- `npm run dev` serves this via Vite with HMR, proxying `/api/*` to the
  gateway (see `vite.config.ts` for the target). **`/v1/*` is not proxied** —
  only the dashboard's own API is. Anything that needs the actual inference
  path (testing OAuth's `fest claude` handoff, for instance) needs the
  gateway's own port, not the Vite dev port.
- `npm run build` is required before `npm start` or Docker will serve
  anything at `/` — the gateway falls back to "API only" when `web/dist`
  doesn't exist yet, which is expected during server-only development.
