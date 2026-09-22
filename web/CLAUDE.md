# web/

The dashboard: Vite + React + TanStack Query + TanStack Charts. The only part
of this repository with an actual build step — the server has none.

- `src/pages/` — one file per screen (Overview, Live, Users, Models, Errors,
  Posture, Admin, Login). Screen order in the nav follows the value order
  from the original plan: credential posture first.
- `src/components/` — shared UI: the chart wrappers (`charts.tsx`), the feed
  table, the routing-config card, small primitives (`ui.tsx`).
- `src/lib/` — the non-visual layer: `api.ts` (fetch wrappers typed against
  `shared/api.ts`), `auth.ts` (session calls), `sse.ts` (the live feed),
  `router.ts`, `range.ts`, `format.ts`.
- `App.tsx` — the session gate (`/api/auth/me`) and the page switch. Any
  request coming back 401 invalidates the `me` query, which is what re-asks
  "am I signed in" instead of leaving stale panels on screen.

## Maintaining this

- **Never import from `server/`.** Only from `shared/` and from `web/src`
  itself — the server's import graph reaches `node:sqlite`, which the
  browser bundle must never see. If a type is needed on both sides, it goes
  in `shared/`, not here.
- API calls go through `src/lib/api.ts`, typed against `shared/api.ts`'s
  wire contracts — don't `fetch()` an endpoint ad hoc from inside a page
  component; add or extend a function in `lib/api.ts` so the shape stays
  centrally typed.
- `npm run dev` serves this via Vite with HMR, proxying `/api/*` to the
  gateway (see `vite.config.ts` for the target). **`/v1/*` is not proxied** —
  only the dashboard's own API is. Anything that needs the actual inference
  path (testing OAuth's `fest claude` handoff, for instance) needs the
  gateway's own port, not the Vite dev port.
- `npm run build` is required before `npm start` or Docker will serve
  anything at `/` — the gateway falls back to "API only" when `web/dist`
  doesn't exist yet, which is expected during server-only development.
