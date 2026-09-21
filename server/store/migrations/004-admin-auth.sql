-- Fest schema, migration 004: dashboard accounts, sessions, audit log.
--
-- Two different authentication systems live in this database and must not be
-- confused:
--
--   identity_tokens  — a developer's Claude Code proving who it is on the
--                      PROXY path. Hot path. sha256, no KDF (see 001).
--   users.password_hash + sessions
--                    — a human signing in to the DASHBOARD. Cold path, human
--                      chosen secret, so scrypt with a per-password salt.
--
-- The proxy path never reads either of the tables below. That is what keeps a
-- slow KDF and a synchronous session lookup off a request that is relaying a
-- developer's stream.

-- NULL password_hash means "this user exists as an attribution target but
-- cannot sign in" — which is every user created by `fest token create`. A
-- dashboard account is granted deliberately, never as a side effect of a
-- developer being metered.
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN password_set_at INTEGER;

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- sha256(raw). The raw value exists only in the operator's cookie, so a
  -- database read — a backup, a support session, a leaked file — cannot be
  -- turned into a live session.
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  -- Absolute cap. A session dies at this instant no matter how active it is,
  -- so a stolen cookie has a bounded life even under constant use.
  expires_at   INTEGER NOT NULL,
  -- Idle timeout, rolled forward as the session is used.
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  -- Recorded for the audit trail, never for authorisation: both are trivially
  -- forged, so binding a session to them would only lock out real users behind
  -- a changing IP.
  user_agent   TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT ''
);

CREATE INDEX sessions_user   ON sessions (org_id, user_id, created_at DESC);
CREATE INDEX sessions_expiry ON sessions (expires_at);

-- Who did what, as an administrative record rather than a debug log.
--
-- Deliberately a table and not the application log: logs rotate, are filtered
-- by level, and are the first thing lost when a container restarts. "When was
-- this token minted, and by whom" is a question asked months later.
CREATE TABLE audit_log (
  seq           INTEGER PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  at            INTEGER NOT NULL,
  -- NULL for an actor who never authenticated — a failed login has no user.
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- What the actor called themselves: the email typed at a failed login, or
  -- "cli" for a command run on the host. Survives the user row being deleted,
  -- which is exactly when the record matters most.
  actor_label   TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,
  target        TEXT NOT NULL DEFAULT '',
  outcome       TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'error')),
  -- Never a credential, never a prompt. Enforced by test.
  detail_json   TEXT NOT NULL DEFAULT '{}',
  ip            TEXT NOT NULL DEFAULT ''
);

CREATE INDEX audit_log_recent ON audit_log (org_id, at DESC);
CREATE INDEX audit_log_actor  ON audit_log (org_id, actor_user_id, at DESC);
