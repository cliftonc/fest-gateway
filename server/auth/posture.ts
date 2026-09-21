/**
 * Inbound credential posture and identity detection.
 *
 * Every request carries up to TWO independent credentials, and conflating them
 * is the bug that breaks subscription auth:
 *
 *  1. The developer's *upstream* credential — their own Claude Max/Team OAuth
 *     bearer (`Authorization: Bearer sk-ant-oat…`) or an API key (`x-api-key`,
 *     or `Authorization: Bearer sk-ant-api…`). This is forwarded to Anthropic.
 *  2. Fest's own *identity* token — "which developer is this?" — which is never
 *     forwarded upstream. It arrives as a URL path prefix (`/t/<token>/…`) or as
 *     an `X-Fest-Token` header.
 *
 * The identity token cannot ride in `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`:
 * setting either of those makes Claude Code silently abandon subscription auth,
 * so the developer's Max token never arrives and we bill the org instead. Hence
 * the two out-of-band carriers.
 */

import type { Posture, Identity } from "../../shared/types.ts";
import { classifyCredential, fingerprint, type CredentialInfo } from "../secret/fingerprint.ts";

export interface InboundAuth {
  readonly posture: Posture;
  /** The upstream credential to forward, if any. */
  readonly upstreamCredential: CredentialInfo | null;
  readonly identity: Identity;
  /** Raw identity token, for authentication only. Must not be stored. */
  readonly identityToken: string | null;
  /** Path with any identity prefix removed, e.g. "/v1/messages?beta=true". */
  readonly effectivePath: string;
}

/**
 * Header positions that may hold the *upstream* credential, in preference order.
 *
 * `x-fest-token` is deliberately absent even though it is a secret header
 * (see SECRET_HEADERS): it is Fest's identity token, not Anthropic's, and
 * forwarding it upstream would authenticate nothing and leak our own bearer.
 */
const UPSTREAM_CREDENTIAL_HEADERS: readonly string[] = ["authorization", "x-api-key"];

/** Path prefixes that carry an identity token. `/t/` is the short form. */
const IDENTITY_PATH_PREFIX = /^\/(?:t|fest)\/([^/?#]+)(\/[^?#]*)?(\?.*|#.*)?$/;

/**
 * Split a leading `/t/<token>` or `/fest/<token>` segment off the request URL.
 *
 * The query string belongs to the remainder, because Claude Code sends
 * `POST /v1/messages?beta=true` and dropping `?beta=true` changes the upstream
 * request shape. A URL with no identity prefix is returned untouched — note the
 * anchored regex, so a normal `/v1/messages` can never be mistaken for a token
 * (its first segment is not `t` or `fest`).
 */
export function parseIdentityPath(url: string): { token: string | null; remainder: string } {
  const match = IDENTITY_PATH_PREFIX.exec(url);
  if (!match) return { token: null, remainder: url };
  const token = match[1] ?? "";
  if (token.length === 0) return { token: null, remainder: url };
  // `/t/<tok>` with nothing after it still has to address a path upstream.
  const path = match[2] ?? "/";
  const suffix = match[3] ?? "";
  return { token, remainder: `${path === "" ? "/" : path}${suffix}` };
}

function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | null {
  // Node lowercases incoming header names, but this is also called with
  // hand-built objects (tests, internal replays), so match case-insensitively.
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const joined = Array.isArray(value) ? value.join(", ") : value;
    if (joined === undefined) return null;
    return joined;
  }
  return null;
}

/**
 * Classify a request's two credential positions in one pass.
 *
 * Posture is *detected*, never configured: it is a property of the developer's
 * own client environment, which Fest does not control.
 */
export function detectInbound(
  url: string,
  headers: Readonly<Record<string, string | string[] | undefined>>,
): InboundAuth {
  let upstreamCredential: CredentialInfo | null = null;
  for (const name of UPSTREAM_CREDENTIAL_HEADERS) {
    const raw = headerValue(headers, name);
    if (raw === null) continue;
    const info = classifyCredential(name, raw);
    // An empty or whitespace-only header is the same as no credential; fall
    // through so a present-but-blank `authorization` does not mask `x-api-key`.
    if (info.kind === "EMPTY") continue;
    upstreamCredential = info;
    break;
  }

  const posture: Posture =
    upstreamCredential?.kind === "ANTHROPIC_OAUTH_SUBSCRIPTION" ? "subscription" : "key";

  const fromPath = parseIdentityPath(url);
  const fromHeader = headerValue(headers, "x-fest-token");
  // Path wins: it is the form we hand developers (`ANTHROPIC_BASE_URL=…/t/<tok>`),
  // so if both are present the URL is the deliberate one.
  const identityToken = fromPath.token ?? (fromHeader !== null && fromHeader.trim() !== "" ? fromHeader.trim() : null);
  const carrier = fromPath.token !== null ? "path" : identityToken !== null ? "header" : "none";

  const identity: Identity = {
    carrier,
    tokenFingerprint: identityToken === null ? null : fingerprint(identityToken),
  };

  return {
    posture,
    upstreamCredential,
    identity,
    identityToken,
    effectivePath: fromPath.remainder,
  };
}
