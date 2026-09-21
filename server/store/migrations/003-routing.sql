-- Phase 4: routing and credential visibility.
--
-- `pipeline` and `route_id` record WHICH decision served a request;
-- `credentials_considered` records WHY. The last is stored as JSON rather than
-- normalised into its own table on purpose: it is an append-only audit note
-- read whole and never queried across, and a join table would invite exactly
-- the partial read ("show me the credential" — which one?) that this field
-- exists to prevent.
--
-- The CHECK is the structural half of the never-persist-a-credential rule.
-- There is no column here a secret belongs in, and this makes that enforceable
-- rather than customary: anything secret-shaped fails the INSERT instead of
-- being written and noticed later, if ever.
--
-- ── Deliberately NOT added to usage_hourly ──────────────────────────────────
--
-- `pipeline` is not a rollup dimension. It would have to join the cube's
-- primary key, which means rebuilding the cube and revisiting the writer's key
-- de-duplication — and a mistake there multiplies every token count in the org
-- totals, which is precisely the bug that shipped and was caught in Phase 2.
--
-- The aggregate question is already answered without it: a substituted request
-- is recorded as `credential_origin = 'fallback_server'`, which IS a rollup
-- dimension. So "how much of our traffic ran on a server-held key" survives
-- retention, while per-ROUTE breakdowns read raw rows and therefore go blank
-- once those age out. That is the same honest limitation the error breakdown
-- already carries, and the right trade against destabilising every number on
-- the dashboard.

ALTER TABLE requests ADD COLUMN pipeline TEXT NOT NULL DEFAULT 'passthrough';
ALTER TABLE requests ADD COLUMN route_id TEXT;
ALTER TABLE requests ADD COLUMN credentials_considered TEXT NOT NULL DEFAULT '[]'
  CHECK (
    credentials_considered NOT LIKE '%sk-ant-%'
    AND credentials_considered NOT LIKE '%sk-or-%'
    AND credentials_considered NOT LIKE '%fw_%'
    AND credentials_considered NOT LIKE '%Bearer %'
  );

-- "Which requests did not run on the caller's own credential" is the compliance
-- question this phase exists to answer, so it gets an index rather than a scan.
CREATE INDEX requests_pipeline ON requests (org_id, pipeline, started_at DESC);
