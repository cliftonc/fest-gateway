/**
 * Fest identity tokens: who is this developer?
 *
 * This is emphatically NOT an upstream provider credential. It is never
 * forwarded to Anthropic, and it cannot be carried in `ANTHROPIC_API_KEY` or
 * `ANTHROPIC_AUTH_TOKEN`, because setting either makes Claude Code abandon
 * subscription auth and fall back to key auth — silently moving a developer off
 * their own plan onto whatever key the server holds. So the token travels in
 * the URL path (`/t/<token>`) or an `X-Fest-Token` header.
 *
 * The raw token is shown exactly once, at creation. We store only sha256(raw)
 * plus a short display prefix.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./db.ts";
import { newId } from "./ids.ts";

const TOKEN_PREFIX = "fest_";
const TOKEN_BYTES = 32;
const DISPLAY_PREFIX_CHARS = 11;

export interface CreatedToken {
  readonly id: string;
  /** The only time the raw value exists. Show it, then forget it. */
  readonly raw: string;
  readonly displayPrefix: string;
}

export interface ResolvedIdentity {
  readonly tokenId: string;
  readonly orgId: string;
  readonly userId: string;
}

export interface TokenSummary {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly displayPrefix: string;
  readonly createdAt: number;
  readonly lastUsedAt: number | null;
  readonly revokedAt: number | null;
  readonly expiresAt: number | null;
}

/**
 * sha256, deliberately not scrypt/bcrypt.
 *
 * These are 32 bytes of CSPRNG output, so there is no dictionary to attack and
 * nothing a slow KDF would buy — while a slow KDF would add its cost to EVERY
 * proxied request, since authentication is on the hot path. User passwords,
 * when they arrive, will use scrypt. Please do not "fix" this.
 */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateToken(): { raw: string; hash: string; displayPrefix: string } {
  const raw = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashToken(raw), displayPrefix: raw.slice(0, DISPLAY_PREFIX_CHARS) };
}

export function createToken(
  store: Store,
  args: { orgId: string; userId: string; name?: string; expiresAt?: number | null },
): CreatedToken {
  const { raw, hash, displayPrefix } = generateToken();
  const id = newId("tok");
  store.db
    .prepare(
      `INSERT INTO identity_tokens
         (id, org_id, user_id, name, token_hash, token_prefix, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      args.orgId,
      args.userId,
      args.name ?? "",
      hash,
      displayPrefix,
      Date.now(),
      args.expiresAt ?? null,
    );
  return { id, raw, displayPrefix };
}

/**
 * Resolve a presented token.
 *
 * Lookup is by hash against a unique index, so there is no meaningful timing
 * channel on the secret itself. The `timingSafeEqual` below guards the
 * comparison of the retrieved hash anyway, which costs nothing and keeps the
 * property locally obvious.
 *
 * Returns null for unknown, revoked and expired tokens alike: the caller must
 * not be able to distinguish them, since that would turn this into an oracle
 * for which tokens once existed.
 */
export function resolveToken(store: Store, raw: string | null): ResolvedIdentity | null {
  if (raw === null || raw.length === 0) return null;
  const hash = hashToken(raw);

  const row = store.db
    .prepare(
      `SELECT id, org_id, user_id, token_hash, expires_at, revoked_at
         FROM identity_tokens
        WHERE token_hash = ?`,
    )
    .get(hash) as
    | {
        id: string;
        org_id: string;
        user_id: string;
        token_hash: string;
        expires_at: number | null;
        revoked_at: number | null;
      }
    | undefined;

  if (row === undefined) return null;

  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(row.token_hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  if (row.revoked_at !== null) return null;
  if (row.expires_at !== null && row.expires_at <= Date.now()) return null;

  return { tokenId: row.id, orgId: row.org_id, userId: row.user_id };
}

export function revokeToken(store: Store, orgId: string, tokenId: string): boolean {
  const res = store.db
    .prepare(
      `UPDATE identity_tokens SET revoked_at = ?
        WHERE id = ? AND org_id = ? AND revoked_at IS NULL`,
    )
    .run(Date.now(), tokenId, orgId);
  return Number(res.changes) > 0;
}

export function listTokens(store: Store, orgId: string): TokenSummary[] {
  const rows = store.db
    .prepare(
      `SELECT id, user_id, name, token_prefix, created_at, last_used_at, revoked_at, expires_at
         FROM identity_tokens WHERE org_id = ? ORDER BY created_at DESC`,
    )
    .all(orgId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r["id"]),
    userId: String(r["user_id"]),
    name: String(r["name"] ?? ""),
    displayPrefix: String(r["token_prefix"]),
    createdAt: Number(r["created_at"]),
    lastUsedAt: r["last_used_at"] === null ? null : Number(r["last_used_at"]),
    revokedAt: r["revoked_at"] === null ? null : Number(r["revoked_at"]),
    expiresAt: r["expires_at"] === null ? null : Number(r["expires_at"]),
  }));
}

/**
 * Coalesced `last_used_at` tracking.
 *
 * Updating this per request would roughly double the write volume of the whole
 * system for information nobody needs to the second. Instead the caller
 * records touches in memory and flushes them periodically.
 */
export function createLastUsedTracker(store: Store, flushIntervalMs = 60_000) {
  const pending = new Map<string, number>();
  const timer = setInterval(() => flush(), flushIntervalMs);
  timer.unref();

  function flush(): void {
    if (pending.size === 0) return;
    const entries = [...pending.entries()];
    pending.clear();
    const stmt = store.db.prepare(`UPDATE identity_tokens SET last_used_at = ? WHERE id = ?`);
    store.transaction(() => {
      for (const [tokenId, at] of entries) stmt.run(at, tokenId);
    });
  }

  return {
    touch(tokenId: string): void {
      pending.set(tokenId, Date.now());
    },
    flush,
    stop(): void {
      clearInterval(timer);
      flush();
    },
  };
}
