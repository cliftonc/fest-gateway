/**
 * Credential classification and fingerprinting.
 *
 * Fest never persists a provider credential. On the subscription path it has no
 * store to put one in: a bearer arrives on a request, is forwarded to Anthropic,
 * and is forgotten. What we keep instead is a *fingerprint* — enough to
 * correlate requests and detect one identity token being shared by two people,
 * and not enough to reconstruct the secret.
 *
 * Used by the request path, the log redactor, and the Phase 0 capture server, so
 * there is exactly one definition of "what is a secret".
 */

import { createHash } from "node:crypto";

/** Headers whose values are credentials. Never log or persist these raw. */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "x-api-key",
  "proxy-authorization",
  "x-anthropic-api-key",
  "x-fireworks-api-key",
  "cookie",
  "set-cookie",
  // Fest's own identity token is a revocable bearer too.
  "x-fest-token",
]);

/** Hop-by-hop headers, never relayed to an upstream. */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "te",
  "trailer",
]);

export type CredentialKind =
  | "ANTHROPIC_OAUTH_SUBSCRIPTION"
  | "ANTHROPIC_API_KEY"
  | "ANTHROPIC_OTHER"
  | "FIREWORKS_KEY"
  | "FIREPASS_KEY"
  | "FEST_IDENTITY_TOKEN"
  | "EMPTY"
  | "UNKNOWN";

export interface CredentialInfo {
  readonly header: string;
  readonly scheme: "Bearer" | "raw";
  readonly kind: CredentialKind;
  /** Family-identifying prefix only — never enough to use. */
  readonly prefix: string;
  readonly length: number;
  readonly fingerprint: string;
}

const PREFIX_CHARS = 11;
const FINGERPRINT_CHARS = 12;

/** Stable, non-reversible short fingerprint. Safe to log and store. */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, FINGERPRINT_CHARS);
}

/**
 * Identify a credential family from its prefix without revealing the secret.
 *
 * The distinction that matters most: `sk-ant-oat…` is a subscription OAuth
 * token (the developer's own, forwarded and forgotten) while `sk-ant-api…` is an
 * API key (metered, possibly server-held). They are billed differently and must
 * never be conflated in reporting.
 */
export function classifyCredential(header: string, rawValue: string): CredentialInfo {
  const value = rawValue.trim();
  const bearer = /^Bearer\s+(.*)$/i.exec(value);
  const token = bearer ? (bearer[1] ?? "") : value;

  let kind: CredentialKind = "UNKNOWN";
  if (token.length === 0) kind = "EMPTY";
  else if (token.startsWith("sk-ant-oat")) kind = "ANTHROPIC_OAUTH_SUBSCRIPTION";
  else if (token.startsWith("sk-ant-api")) kind = "ANTHROPIC_API_KEY";
  else if (token.startsWith("sk-ant-")) kind = "ANTHROPIC_OTHER";
  else if (token.startsWith("fw_")) kind = "FIREWORKS_KEY";
  else if (token.startsWith("fpk_")) kind = "FIREPASS_KEY";
  else if (token.startsWith("fest_")) kind = "FEST_IDENTITY_TOKEN";

  return {
    header,
    scheme: bearer ? "Bearer" : "raw",
    kind,
    prefix: token.slice(0, Math.min(PREFIX_CHARS, token.length)),
    length: token.length,
    fingerprint: fingerprint(token),
  };
}

/** True when this credential is a developer's own subscription (pass-through path). */
export function isSubscriptionCredential(info: CredentialInfo): boolean {
  return info.kind === "ANTHROPIC_OAUTH_SUBSCRIPTION";
}

/**
 * Last-resort log scrubber. Redaction that relies on programmer discipline
 * fails, so every log line passes through this regardless of where it came from.
 */
const SECRET_PATTERN =
  /\b(?:sk-ant|sk|pk|ghp|gho|ghs|ghu|github_pat|xox[bpoars]|fw|fpk|fest)[-_][\w-]{8,}\b/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "<redacted>");
}

/**
 * Split request headers into credentials (fingerprinted) and the rest (kept).
 */
export function partitionHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): { credentials: CredentialInfo[]; plain: Record<string, string> } {
  const credentials: CredentialInfo[] = [];
  const plain: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const joined = Array.isArray(value) ? value.join(", ") : (value ?? "");
    if (SECRET_HEADERS.has(lower)) credentials.push(classifyCredential(lower, joined));
    else plain[lower] = joined;
  }
  return { credentials, plain };
}
