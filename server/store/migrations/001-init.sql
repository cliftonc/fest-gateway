-- Fest schema, migration 001.
--
-- Conventions:
--   * Timestamps are INTEGER epoch milliseconds. No timezone class of bug.
--   * Booleans are INTEGER 0/1.
--   * Entity ids are TEXT with a kind prefix (org_, usr_, tok_) so they are
--     safe in URLs and self-describing in logs.
--   * `requests` uses the integer rowid as its primary key: monotonic, cheap,
--     and it gives keyset pagination for free. `id` is the external uuid.
--   * org_id is on every tenant table from day one even though the spike seeds
--     a single org. The column costs nothing now; retrofitting it across a
--     request table and every query later costs a week and a data migration.

PRAGMA foreign_keys = ON;

CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  -- retention_days, member_visibility, etc. Kept as JSON so adding a setting
  -- is not a migration.
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  disabled_at  INTEGER,
  created_at   INTEGER NOT NULL,
  UNIQUE (org_id, email)
);

-- What a developer's Claude Code presents to Fest so usage can be attributed.
--
-- This is NOT an upstream provider credential. It is never forwarded to
-- Anthropic, and it deliberately cannot live in ANTHROPIC_API_KEY or
-- ANTHROPIC_AUTH_TOKEN, because setting either makes Claude Code abandon
-- subscription auth. It travels in the URL path or an X-Fest-Token header.
CREATE TABLE identity_tokens (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL DEFAULT '',
  -- sha256(raw), hex. The raw token is shown exactly once, at creation.
  --
  -- sha256 and not scrypt/bcrypt on purpose: these are 32 bytes of
  -- randomBytes, so there is no dictionary to attack and nothing for a slow
  -- KDF to buy — while a slow KDF would add its cost to EVERY proxied request.
  -- User passwords, when they arrive, do use scrypt. Do not "fix" this.
  token_hash   TEXT NOT NULL UNIQUE,
  -- Display-only, e.g. "fest_7Fq2…". Lets the UI and support identify a token
  -- without ever holding it.
  token_prefix TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER,
  revoked_at   INTEGER,
  -- Updated coarsely (batched), never per request: it would double the write
  -- volume for information nobody needs to the second.
  last_used_at INTEGER
);

CREATE INDEX identity_tokens_live ON identity_tokens (token_hash) WHERE revoked_at IS NULL;
CREATE INDEX identity_tokens_user ON identity_tokens (org_id, user_id);

-- One row per completed upstream call. The hot table.
CREATE TABLE requests (
  seq                   INTEGER PRIMARY KEY,
  id                    TEXT NOT NULL UNIQUE,
  -- Deliberately NOT a foreign key, unlike users/identity_tokens: this is the
  -- hot insert path and an FK check per row buys nothing here, since org_id is
  -- supplied by the server rather than a client. Please do not "fix" the
  -- asymmetry by adding REFERENCES.
  org_id                TEXT NOT NULL,
  -- Nullable: a request with no identity token is recorded as unattributed
  -- rather than dropped. We never guess who it was.
  user_id               TEXT,
  token_id              TEXT,

  started_at            INTEGER NOT NULL,
  ended_at              INTEGER NOT NULL,

  -- Credential dimension. This is the compliance story, so it is first-class:
  -- an admin must be able to see at a glance which requests ran on a
  -- developer's own subscription versus a server-held key.
  posture               TEXT NOT NULL,
  identity_carrier      TEXT NOT NULL,
  caller_fingerprint    TEXT,
  -- Fingerprint only. A bearer is never stored; there is no column for one.
  credential_fingerprint TEXT,
  credential_origin     TEXT NOT NULL,

  -- Claude Code supplies this itself, so session grouping is free.
  session_id            TEXT,

  requested_model       TEXT,
  served_model          TEXT,
  upstream              TEXT NOT NULL,

  stream                INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL,
  http_status           INTEGER,
  error_type            TEXT,
  error_message         TEXT,
  partial               INTEGER NOT NULL DEFAULT 0,

  -- DISJOINT billing buckets. input_tokens excludes both cache reads and cache
  -- writes; context size is the sum of all four. Folding cache reads into
  -- input is an order-of-magnitude error on a cache-heavy agent workload,
  -- which Claude Code is.
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  web_searches          INTEGER NOT NULL DEFAULT 0,
  service_tier          TEXT,

  -- NULL means no dollar figure applies or is available. It does NOT mean zero.
  -- cost_basis says which: 'subscription' (the developer's own plan absorbed
  -- it, so there is no org spend), 'list' (priced), or 'none' (unknown model).
  -- A SUM() over this column silently skips NULLs, which is why the rollup
  -- carries unpriced_requests alongside the priced sum.
  cost_usd              REAL,
  cost_basis            TEXT NOT NULL DEFAULT 'none',

  ttfb_ms               INTEGER,
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  bytes_in              INTEGER NOT NULL DEFAULT 0,
  bytes_out             INTEGER NOT NULL DEFAULT 0,

  upstream_request_id   TEXT,

  -- Anthropic's unified quota headers, on every response. For a subscription
  -- developer THIS is the scarce resource, not dollars, so it is stored as
  -- queryable columns rather than opaque JSON.
  rl_status             TEXT,
  rl_5h_utilization     REAL,
  rl_5h_status          TEXT,
  rl_5h_reset_at        INTEGER,
  rl_7d_utilization     REAL,
  rl_7d_status          TEXT,
  rl_7d_reset_at        INTEGER,
  rl_claim              TEXT,
  rl_overage_status     TEXT,
  rl_overage_reason     TEXT,

  client_version        TEXT
);

-- One index per dashboard query shape. None speculative.
CREATE INDEX requests_feed      ON requests (org_id, started_at DESC);
CREATE INDEX requests_user      ON requests (org_id, user_id, started_at DESC);
CREATE INDEX requests_model     ON requests (org_id, served_model, started_at DESC);
CREATE INDEX requests_credential ON requests (org_id, credential_origin, started_at DESC);
CREATE INDEX requests_session   ON requests (org_id, session_id, started_at DESC);
-- Partial: the errors view then scans ~1% of rows instead of all of them.
CREATE INDEX requests_errors    ON requests (org_id, started_at DESC) WHERE error_type IS NOT NULL;

-- Hourly rollups. Survive raw-row deletion and serve every chart beyond the
-- live window, so long-range trends keep working after the PII-bearing rows
-- have aged out.
CREATE TABLE usage_hourly (
  org_id                TEXT NOT NULL,
  hour_start            INTEGER NOT NULL,
  -- '' is the "all" bucket for each dimension, so one table serves both
  -- per-user and org-wide queries.
  user_id               TEXT NOT NULL DEFAULT '',
  served_model          TEXT NOT NULL DEFAULT '',
  credential_origin     TEXT NOT NULL DEFAULT '',
  cost_basis            TEXT NOT NULL DEFAULT '',

  requests              INTEGER NOT NULL DEFAULT 0,
  errors                INTEGER NOT NULL DEFAULT 0,

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  web_searches          INTEGER NOT NULL DEFAULT 0,

  -- Sum of PRICED rows only, plus the count of rows we could not price, so a
  -- total can be rendered honestly as "$12.3456 (+3 n/a)" rather than being
  -- quietly short.
  cost_usd              REAL NOT NULL DEFAULT 0,
  unpriced_requests     INTEGER NOT NULL DEFAULT 0,
  -- Requests absorbed by a developer's own subscription: real usage, no org
  -- spend. Counted separately so it is never added to a dollar total.
  subscription_requests INTEGER NOT NULL DEFAULT 0,

  duration_ms_sum       INTEGER NOT NULL DEFAULT 0,
  duration_ms_max       INTEGER NOT NULL DEFAULT 0,
  ttfb_ms_sum           INTEGER NOT NULL DEFAULT 0,
  ttfb_count            INTEGER NOT NULL DEFAULT 0,

  -- Fixed latency histogram buckets rather than percentiles: percentiles do
  -- not merge across rollup rows, but bucket counts add. Boundaries are
  -- <1s, <3s, <10s, <30s, <60s, >=60s.
  lat_b0 INTEGER NOT NULL DEFAULT 0,
  lat_b1 INTEGER NOT NULL DEFAULT 0,
  lat_b2 INTEGER NOT NULL DEFAULT 0,
  lat_b3 INTEGER NOT NULL DEFAULT 0,
  lat_b4 INTEGER NOT NULL DEFAULT 0,
  lat_b5 INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (org_id, hour_start, user_id, served_model, credential_origin, cost_basis)
) WITHOUT ROWID;

CREATE INDEX usage_hourly_time ON usage_hourly (org_id, hour_start DESC);
