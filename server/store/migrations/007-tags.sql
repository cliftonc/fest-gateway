-- Request tags: free-form `key=value` labels a client declares about its own
-- traffic (`team=platform,project=fest`). See shared/tags.ts.
--
-- Self-declared, like `client`, so reporting and never policy. Stored as the
-- canonical JSON object (sorted keys) so the same tag set is always the same
-- string. NULL on `requests` / '' on the rollup means untagged, which is every
-- row written before this migration.

ALTER TABLE requests ADD COLUMN tags_json TEXT;

-- ── Tags ARE a rollup dimension, unlike `client` ─────────────────────────────
--
-- `client` stayed out of the cube (006) because it answers one panel. Tags
-- filter every panel, at every range, and long ranges are served from this
-- table — after retention has deleted the raw rows, from nowhere else. A tag
-- that lived only on `requests` would make a 30-day "project=fest" view first
-- slow and then wrong.
--
-- The dimension is the whole tag SET, not one row per tag:
--   * the writer still upserts the same four cube keys per request, so write
--     cost does not multiply with the number of tags;
--   * any AND of tags is answerable (`json_extract` per key over the set);
--   * "all tags" needs no sentinel row — every read already SUMs across the
--     non-pinned dimensions (credential_origin, cost_basis), and now `tags`.
-- A developer uses a handful of tag sets an hour, so the cube grows by a small
-- factor and stays far smaller than `requests`.
--
-- SQLite cannot change a primary key in place, so the table is rebuilt. Every
-- existing row becomes `tags = ''` with its counters untouched.

CREATE TABLE usage_hourly_new (
  org_id                TEXT NOT NULL,
  hour_start            INTEGER NOT NULL,
  user_id               TEXT NOT NULL DEFAULT '',
  served_model          TEXT NOT NULL DEFAULT '',
  credential_origin     TEXT NOT NULL DEFAULT '',
  cost_basis            TEXT NOT NULL DEFAULT '',
  tags                  TEXT NOT NULL DEFAULT '',

  requests              INTEGER NOT NULL DEFAULT 0,
  errors                INTEGER NOT NULL DEFAULT 0,

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  web_searches          INTEGER NOT NULL DEFAULT 0,

  cost_usd              REAL NOT NULL DEFAULT 0,
  unpriced_requests     INTEGER NOT NULL DEFAULT 0,
  subscription_requests INTEGER NOT NULL DEFAULT 0,
  notional_cost_usd          REAL NOT NULL DEFAULT 0,
  notional_unpriced_requests INTEGER NOT NULL DEFAULT 0,

  duration_ms_sum       INTEGER NOT NULL DEFAULT 0,
  duration_ms_max       INTEGER NOT NULL DEFAULT 0,
  ttfb_ms_sum           INTEGER NOT NULL DEFAULT 0,
  ttfb_count            INTEGER NOT NULL DEFAULT 0,

  lat_b0 INTEGER NOT NULL DEFAULT 0,
  lat_b1 INTEGER NOT NULL DEFAULT 0,
  lat_b2 INTEGER NOT NULL DEFAULT 0,
  lat_b3 INTEGER NOT NULL DEFAULT 0,
  lat_b4 INTEGER NOT NULL DEFAULT 0,
  lat_b5 INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, hour_start, user_id, served_model, credential_origin, cost_basis, tags)
) WITHOUT ROWID;

INSERT INTO usage_hourly_new (
  org_id, hour_start, user_id, served_model, credential_origin, cost_basis, tags,
  requests, errors,
  input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  output_tokens, web_searches,
  cost_usd, unpriced_requests, subscription_requests,
  notional_cost_usd, notional_unpriced_requests,
  duration_ms_sum, duration_ms_max, ttfb_ms_sum, ttfb_count,
  lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5
)
SELECT
  org_id, hour_start, user_id, served_model, credential_origin, cost_basis, '',
  requests, errors,
  input_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
  output_tokens, web_searches,
  cost_usd, unpriced_requests, subscription_requests,
  notional_cost_usd, notional_unpriced_requests,
  duration_ms_sum, duration_ms_max, ttfb_ms_sum, ttfb_count,
  lat_b0, lat_b1, lat_b2, lat_b3, lat_b4, lat_b5
FROM usage_hourly;

DROP TABLE usage_hourly;
ALTER TABLE usage_hourly_new RENAME TO usage_hourly;
CREATE INDEX usage_hourly_time ON usage_hourly (org_id, hour_start DESC);
