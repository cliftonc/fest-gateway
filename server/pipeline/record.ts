/**
 * Building a usage record.
 *
 * Shared by both pipelines — but only this. The two pipelines deliberately do
 * not share a request path, because the byte-for-byte rule on the subscription
 * side is only enforceable while there is no common code path tempting someone
 * to add "just one" transform to it. What they SHOULD share is the shape of
 * what they record, so that a field added for one is never silently absent for
 * the other: a dashboard column that is populated on one path and blank on the
 * other is worse than a column that does not exist.
 */

import type {
  CredentialAttempt,
  Pipeline,
  RequestStatus,
  UsageRecord,
} from "../../shared/types.ts";
import { EMPTY_USAGE } from "../../shared/types.ts";

export interface RecordBase {
  readonly id: string;
  readonly startedAt: number;
  readonly pipeline: Pipeline;
  readonly upstream: string;
  readonly posture: UsageRecord["posture"];
  readonly identityCarrier: UsageRecord["identityCarrier"];
  readonly callerFingerprint: string | null;
  readonly userId: string | null;
  readonly tokenId: string | null;
  readonly credentialFingerprint: string | null;
  readonly credentialOrigin: UsageRecord["credentialOrigin"];
  readonly sessionId: string | null;
  readonly clientVersion: string | null;
  readonly routeId: string | null;
  readonly credentialsConsidered: readonly CredentialAttempt[];
}

export function buildRecord(
  base: RecordBase,
  partial: Partial<UsageRecord> & { status: RequestStatus },
): UsageRecord {
  return {
    id: base.id,
    startedAt: base.startedAt,
    endedAt: Date.now(),
    posture: base.posture,
    identityCarrier: base.identityCarrier,
    callerFingerprint: base.callerFingerprint,
    userId: base.userId,
    tokenId: base.tokenId,
    credentialFingerprint: base.credentialFingerprint,
    credentialOrigin: base.credentialOrigin,
    sessionId: base.sessionId,
    requestedModel: null,
    servedModel: null,
    upstream: base.upstream,
    stream: false,
    httpStatus: null,
    partial: false,
    usage: EMPTY_USAGE,
    costUsd: null,
    costBasis: "none",
    notionalCostUsd: null,
    ttfbMs: null,
    durationMs: Date.now() - base.startedAt,
    bytesIn: 0,
    bytesOut: 0,
    upstreamRequestId: null,
    rateLimit: null,
    clientVersion: base.clientVersion,
    pipeline: base.pipeline,
    routeId: base.routeId,
    credentialsConsidered: base.credentialsConsidered,
    ...partial,
  };
}
