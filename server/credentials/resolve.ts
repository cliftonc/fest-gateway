/**
 * Decide which credential serves a request, and record every candidate.
 *
 * The output is as much an audit trail as a decision. `credentialsConsidered`
 * goes onto every usage record because silent credential substitution is a
 * billing incident: the developer believes their subscription paid, the org is
 * invoiced, and without this list nothing anywhere records that a choice was
 * even made.
 *
 * Two rules this module exists to make structural rather than customary:
 *
 *  1. **An inbound subscription bearer is never used for a substitute route.**
 *     It was issued by Anthropic for Anthropic. Forwarding it to Fireworks
 *     would disclose a developer's personal credential to a third party. It is
 *     recorded as `skipped`, with the reason, so the decision is visible.
 *
 *  2. **A missing server credential fails the request.** It does not quietly
 *     fall back to the pass-through path. Falling back would silently serve a
 *     different model than the one asked for, on a credential the requester did
 *     not choose — the request succeeding is precisely what makes that bad.
 */

import type { CredentialAttempt } from "../../shared/types.ts";
import type { NonPersistable } from "../secret/non-persistable.ts";
import type { SecretResolver } from "./provider.ts";
import type { RouteDecision } from "../routes/resolve.ts";

export interface InboundCredential {
  readonly fingerprint: string;
  readonly isSubscription: boolean;
}

export type CredentialOutcome =
  | {
      readonly ok: true;
      /** Present only on the substitute path; pass-through relays the inbound one. */
      readonly secret: NonPersistable<string> | null;
      readonly source: string;
      readonly considered: readonly CredentialAttempt[];
    }
  | {
      readonly ok: false;
      readonly message: string;
      readonly considered: readonly CredentialAttempt[];
    };

export function resolveCredential(
  decision: RouteDecision,
  inbound: InboundCredential | null,
  secrets: SecretResolver,
): CredentialOutcome {
  const considered: CredentialAttempt[] = [];

  // ── pass-through ────────────────────────────────────────────────────────────
  if (decision.pipeline === "passthrough" || decision.upstream === null) {
    if (inbound === null) {
      considered.push({
        source: "inbound",
        result: "missing",
        reason: "no credential on the request",
      });
      // Not an error here: upstream decides. Anthropic's own 401 is a better
      // message than anything Fest could invent, and the client's refresh
      // latch is waiting for exactly that response.
      return { ok: true, secret: null, source: "inbound", considered };
    }
    considered.push({
      source: inbound.isSubscription ? "inbound_subscription" : "inbound_key",
      result: "used",
    });
    return { ok: true, secret: null, source: considered[0]?.source ?? "inbound", considered };
  }

  // ── substitute ──────────────────────────────────────────────────────────────
  const upstream = decision.upstream;

  if (inbound !== null && inbound.isSubscription) {
    considered.push({
      source: "inbound_subscription",
      result: "skipped",
      reason: `not sent to ${upstream.id}: a Claude subscription credential is only valid at Anthropic, and forwarding it would disclose it to another vendor`,
    });
  } else if (inbound !== null) {
    considered.push({
      source: "inbound_key",
      result: "skipped",
      reason: `not sent to ${upstream.id}: an inbound key is scoped to its own issuer`,
    });
  }

  const resolvedSecret = secrets.resolve(upstream.credential);
  if (resolvedSecret === null) {
    considered.push({
      source: upstream.credential.source,
      result: "missing",
      reason: "environment variable is unset or empty",
    });
    return {
      ok: false,
      considered,
      message:
        `Fest: route ${JSON.stringify(decision.route?.id ?? "?")} sends ` +
        `${JSON.stringify(decision.requestedModel ?? "?")} to upstream ${JSON.stringify(upstream.id)}, ` +
        `whose credential ${upstream.credential.source} is not set on the Fest server. ` +
        `This request was refused rather than served on a different credential.`,
    };
  }

  considered.push({ source: resolvedSecret.source, result: "used" });
  return {
    ok: true,
    secret: resolvedSecret.value,
    source: resolvedSecret.source,
    considered,
  };
}
