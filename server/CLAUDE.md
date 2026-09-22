# server/

The gateway. Runs as plain TypeScript — no build step, no runtime
dependencies beyond `arctic` and `open` (the latter only reachable from
`cli/`, never imported here). Node's native type stripping is why this works.

## Subsystems

- **`bin/fest.ts`** — the CLI entrypoint. Server-operator commands (`serve`,
  `migrate`, `token`, `admin`, `seed`) load `FestConfig` via `loadConfig()`;
  developer commands (`login`, `whoami`, `claude`, `logout`) dispatch to
  `cli/` *before* that call, and must stay that way — a laptop has no reason
  to have any `FEST_*` server env var set.
- **`http/`** — the raw HTTP layer. `server.ts` is a single manual
  if/else-chain dispatcher (not a router table) so the byte-for-byte
  passthrough path can bypass body-parsing entirely; `sse.ts` is the
  incremental SSE parser; `body.ts` keeps request bodies as opaque bytes;
  `pipe.ts` does the client-first tee; `headers.ts`, `errors.ts`, `static.ts`
  round out the rest.
- **`pipeline/`** — `dispatch.ts` picks passthrough vs. substitute per
  request; `passthrough.ts` relays the subscription path byte-for-byte,
  deliberately *not* using the adapter interface; `substitute.ts` routes
  through a server-held credential; `record.ts` builds the usage record;
  `count-tokens.ts` handles `/v1/messages/count_tokens`.
- **`adapters/`** — per-provider substitute-path adapters (`anthropic.ts`,
  `fireworks.ts`). An adapter is a credential + model-id swap, not a wire
  translator — Fireworks serves an Anthropic-compatible `/v1/messages`, so
  the existing SSE parser and accumulator meter it unchanged.
- **`routes/`** — the routing table: `table.ts` parses and validates it,
  `resolve.ts` matches a request to a route (exact ids beat wildcards
  regardless of file order), `watch.ts` hot-reloads it without a restart.
- **`auth/`** — two authentication systems that must never be conflated:
  dashboard sessions (`accounts.ts`, `session.ts`, `password.ts`, `guard.ts`,
  `oauth.ts`) gate `/api/*` only; `posture.ts` detects a developer's identity
  token on the proxy path (`/v1/*`) and must never require a browser session.
  `gateway-401.ts` builds the user-facing error text shown to Claude Code
  itself.
- **`api/cli-auth.ts`** — `fest login`'s authorise + approve pair, and the only
  server-rendered HTML in the codebase. It mints an identity token from a
  dashboard session, so the approval POST's origin check and the loopback-only
  check on `cli_redirect_uri` are load-bearing, not ceremony. The page must
  never declare a `no-referrer` policy: browsers null `Origin` on form
  submissions under it, and the origin check then refuses its own button.
- **`api/`** — the dashboard's JSON API. `routes.ts` is the read surface
  (asserts every response `satisfies` `shared/api.ts`); `auth.ts` is
  password sign-in/out/`me`; `oauth.ts` is Google/GitHub sign-in for both
  the dashboard and `fest login`, plus `/api/auth/identity`; `live.ts` is
  the SSE feed; `models.ts` is the `/v1/models` gateway menu.
- **`store/`** — SQLite (via `node:sqlite`), forward-only migrations in
  `store/migrations/*.sql`, the write path (`write.ts`, bounded queue +
  batched flush, never on the request path), `queries.ts` (org/member
  scoping enforced *inside* the query layer, fails closed with no
  `userId`), `tokens.ts` (identity tokens), `bootstrap.ts` (`ensureOrg`/
  `ensureUser`, idempotent), `audit.ts`, `retention.ts`, `seed.ts`.
- **`usage/`** — `accumulator.ts` (SSE usage events, last-wins on
  `output_tokens`, never summed), `cost.ts` (null-propagating cost algebra —
  `null` means unavailable, never zero), `pricing.ts` (prices one call, and
  returns BOTH org spend and notional list-rate value), `prices/` (the vendored
  litellm catalog, its lookup table and its background refresh). Boot loads the
  snapshot synchronously; the refresh is best-effort and never blocks a
  request. See `docs/PRICING.md` before changing anything in there.
- **`credentials/`** — resolves a routing table's `{env:NAME}` references to
  actual secrets at request time; the routing table itself never holds one.
- **`ingest/`** — `sink.ts` (the bounded queue + batched writer) and
  `live-bus.ts` (publishes from the sink's flush, never from the request
  path, so a slow dashboard subscriber can never add latency to a
  developer's live turn).
- **`secret/`** — `fingerprint.ts` (one definition of "this looks like a
  secret," used by the log redactor and the leak tests) and
  `non-persistable.ts` (a wrapper whose `toString`/`toJSON` always redact).
- **`basePath`** — Fest may be mounted under a path. `config.ts` derives it
  from `FEST_PUBLIC_URL`, `http/server.ts` strips it from incoming requests
  (the proxy may or may not have already), and `http/static.ts` rewrites the
  dashboard's `<base href>` to it. Any new redirect or absolute URL the server
  hands a browser must be built on it — `${cfg.basePath}/`, never `/`.
- **`config.ts`** — all configuration, entirely from the environment,
  validated once at boot. **Any field added here that can hold a secret must
  also be redacted in `describeConfig()`** — that function's whole job is to
  be safe to log.
- **`log.ts`** — mandatory redaction on every line.

## Maintaining this

- **The passthrough path's byte-for-byte rule is load-bearing, not a style
  preference.** A subscription OAuth bearer is validated against request
  shape; never `JSON.parse` → `JSON.stringify` a body anywhere on that path.
- **No credential is persistable, structurally, not by policy.** If you find
  yourself adding a column or field that could hold a bearer or API key at
  rest, stop — there should be no store to put it in.
- **Fail closed on ambiguous scope.** The query layer throwing on a
  `member` scope with no `userId` (rather than quietly widening to the org)
  is deliberate; new query functions should follow the same shape.
- New migrations are forward-only, numbered sequentially in
  `store/migrations/`, and must preserve existing rows — verify against a
  real upgraded database, not just a fresh one.
- If a change could route a subscription request through a substitute
  provider by mistake, that's the one class of bug this whole codebase is
  built to make structurally impossible — treat it accordingly.
