/**
 * Claude in Amazon Bedrock, on the DEVELOPER's own AWS credential.
 *
 * Claude Code's Bedrock "mantle" client speaks the ordinary Anthropic Messages
 * API — same body, same SSE framing — at
 * `https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages`. Verified by
 * reading the client in 2.1.278: `AnthropicBedrockMantle` builds its base URL
 * as `…api.aws/anthropic`, `ANTHROPIC_BEDROCK_MANTLE_BASE_URL` REPLACES that
 * whole value, and no middleware rewrites the path (unlike the legacy
 * `AnthropicBedrock` client, which turns `/v1/messages` into
 * `/model/{id}/invoke` and re-frames the stream as AWS eventstream). So a
 * client pointed at Fest sends a plain `POST /v1/messages` that this proxy can
 * relay as-is.
 *
 * Auth is a plain bearer: with `AWS_BEARER_TOKEN_BEDROCK` set, that client
 * sends `Authorization: Bearer …` and does not sign. That is why this works at
 * all — SigV4 signs the Host header, so a signed request cannot survive a proxy
 * that has to rewrite Host to reach the real endpoint.
 *
 * ── Why a mount, and not sniffing the model id ───────────────────────────────
 *
 * A Bedrock-mode request is identified by the URL the developer configured
 * (`…/bedrock`), not by its `anthropic.`-prefixed model id. Two reasons:
 *
 *  - it costs nothing. The model id lives in the BODY, so sniffing it would
 *    mean reading and parsing a body on the hot path that Fest otherwise
 *    forwards without looking at;
 *  - it cannot misfire. A developer who forces a non-prefixed id in Bedrock
 *    mode would otherwise have their AWS bearer sent to api.anthropic.com,
 *    which is a 401 they cannot explain — and, worse, the reverse mistake would
 *    send an Anthropic subscription bearer to AWS.
 *
 * ── Why Fest never holds the credential ──────────────────────────────────────
 *
 * Bedrock's bearer tokens last 12 hours at most, and Fest resolves credentials
 * from `{env:NAME}` only — nothing can rewrite a running process's environment,
 * so a server-held Bedrock token means a restart twice a day. The developer's
 * client can refresh its own (`awsAuthRefresh` / `awsCredentialExport` are
 * Claude Code credential helpers, and the client maps both to
 * `ANTHROPIC_BEDROCK_MANTLE_BASE_URL`), next to the SSO session that is the only
 * thing able to mint one non-interactively.
 *
 * So this path holds the same property as the subscription path: the credential
 * is forwarded and forgotten. It is never stored, and there is no server-held
 * Bedrock credential to store. As a bonus, AWS sees the developer's own
 * identity, so CloudTrail attributes each call to a person rather than to one
 * shared token.
 *
 * ── Why it bypasses the routing table ────────────────────────────────────────
 *
 * Deliberately: this mount means "relay this on MY credential". Letting a route
 * substitute it onto a server-held key would be the silent credential swap this
 * codebase exists to make impossible, and an `anthropic.claude-*` rule written
 * for some other purpose is all it would take.
 */

import { anthropicError } from "../http/errors.ts";
import type { ServerResponse } from "node:http";

/** The inbound mount. Comes after any `/t/<token>` identity prefix. */
export const BEDROCK_MOUNT = "/bedrock";

/**
 * Split the Bedrock mount off a path, or null when it is not one.
 *
 * `/bedrock` alone yields `/`, so everything downstream still matches on a
 * leading slash, and `/bedrockish` is not read as the mount plus `ish`.
 */
export function splitBedrockMount(path: string): string | null {
  if (!path.startsWith(BEDROCK_MOUNT)) return null;
  const rest = path.slice(BEDROCK_MOUNT.length);
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : null;
}

/**
 * Refuse a Bedrock-mounted request when no Bedrock upstream is configured.
 *
 * An explicit refusal, not a fall-through to Anthropic: falling through would
 * send a developer's AWS bearer to api.anthropic.com, and the 401 that came
 * back would say nothing about the actual mistake.
 */
export function refuseUnconfigured(res: ServerResponse): void {
  res.writeHead(501, { "content-type": "application/json", "x-should-retry": "false" });
  res.end(
    anthropicError(
      "invalid_request_error",
      "Fest: this gateway has no Bedrock upstream configured. " +
        "Set FEST_BEDROCK_BASE_URL (e.g. https://bedrock-mantle.us-east-1.api.aws/anthropic) " +
        "to relay Bedrock traffic on the caller's own AWS credential.",
    ),
  );
}
