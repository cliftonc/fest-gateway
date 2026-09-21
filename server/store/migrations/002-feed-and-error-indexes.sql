-- Migration 002: fix two indexes that did not match how the code actually
-- queries. Both were found by building the read layer against 001.

-- 1. The keyset feed had no index.
--
-- The feed pages with `WHERE org_id = ? AND seq < ? ORDER BY seq DESC`, but
-- `requests_feed` is (org_id, started_at DESC) and cannot order by seq. SQLite
-- fell back to a descending rowid search: technically a SEARCH rather than a
-- SCAN, so it looked fine in a query plan, but it walks other orgs' rows to
-- find yours. Harmless at one org, wrong at ten.
CREATE INDEX requests_feed_seq ON requests (org_id, seq DESC);

-- 2. The errors partial index keyed off the wrong predicate.
--
-- 001 defined it as `error_type IS NOT NULL`, but "is an error" everywhere in
-- the code is `status <> 'ok'` — which is what the writer counts and what the
-- errors view filters on. The two disagree for exactly the rows that matter
-- most: `identity_denied` and `client_abort` are non-ok and carry no
-- error_type, so they were invisible to the index and the errors view could
-- not use it at all.
--
-- Aligning the index to the code rather than the reverse, because `status` is
-- the authoritative field: it is NOT NULL and always set, while error_type is
-- incidental detail.
DROP INDEX IF EXISTS requests_errors;
CREATE INDEX requests_errors ON requests (org_id, started_at DESC) WHERE status <> 'ok';
