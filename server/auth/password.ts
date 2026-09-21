/**
 * Dashboard passwords: scrypt, with the parameters stored alongside the hash.
 *
 * Why scrypt here and sha256 for identity tokens (see store/tokens.ts): a
 * 32-byte random token has no dictionary to attack, so a slow KDF buys nothing
 * and costs every proxied request. A human-chosen password is the opposite on
 * both counts — it is guessable, and it is verified once per login, off the hot
 * path entirely.
 *
 * The encoded form is `scrypt$N$r$p$salt$hash`, all base64url. Storing the
 * parameters rather than assuming them means today's cost factor can be raised
 * later without invalidating existing passwords: an old hash still verifies
 * with the parameters it was written with, and `needsRehash` says when to
 * upgrade it on next successful login.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** ~100ms on a 2024 laptop, and within Node's default maxmem at r=8. */
export const CURRENT_PARAMS: ScryptParams = { N: 16_384, r: 8, p: 1 };

const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** N=16384,r=8 needs ~16MB; the headroom covers a future raise of N. */
const MAXMEM = 128 * 1024 * 1024;

const b64 = (b: Buffer): string => b.toString("base64url");

/**
 * Minimum length only — no composition rules.
 *
 * Character-class requirements measurably push people toward `Password1!` and
 * are not what stands between this database and an attacker; a slow KDF and a
 * non-guessable length are. `fest admin create` generates a random password by
 * default, which is the path most operators should take.
 */
export const MIN_PASSWORD_LENGTH = 12;

export function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (password.length > 1024) {
    // Not a policy, a denial-of-service bound: scrypt cost scales with input.
    return "password must be at most 1024 characters";
  }
  return null;
}

export async function hashPassword(password: string, params: ScryptParams = CURRENT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password, salt, KEY_BYTES, { ...params, maxmem: MAXMEM });
  return ["scrypt", params.N, params.r, params.p, b64(salt), b64(key)].join("$");
}

/**
 * Verify a password against an encoded hash.
 *
 * Returns false rather than throwing for a malformed stored value: a corrupted
 * row must read as "this password does not match", not as a 500 that tells an
 * attacker they found something interesting.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // A hostile row could otherwise name parameters that hang the process.
  if (N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64url");
    expected = Buffer.from(parts[5] ?? "", "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scrypt(password, salt, expected.length, { N, r, p, maxmem: MAXMEM });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** True when a stored hash was written with weaker parameters than today's. */
export function needsRehash(encoded: string, params: ScryptParams = CURRENT_PARAMS): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true;
  return Number(parts[1]) < params.N || Number(parts[2]) < params.r;
}

/**
 * A password nobody has to invent. ~103 bits of entropy in a shape that
 * survives being read aloud once and pasted into a password manager.
 */
export function generatePassword(): string {
  const raw = randomBytes(16).toString("base64url").replace(/[-_]/g, "");
  return (raw.match(/.{1,6}/g) ?? [raw]).slice(0, 4).join("-");
}
