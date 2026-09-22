/**
 * Anthropic as an EXPLICIT upstream — i.e. an org's own API key, not a
 * developer's subscription.
 *
 * This is not the pass-through path and must not be confused with it. It exists
 * for the case where an operator deliberately routes some model to Anthropic on
 * a key the SERVER holds, which is org spend and is recorded as
 * `fallback_server`. The subscription path never comes through here; it never
 * touches an adapter at all.
 */

import type { Adapter, AdapterPlan, AdapterRequest } from "./index.ts";
import { rewriteModel } from "./rewrite.ts";
import { joinUpstreamUrl } from "./url.ts";

/**
 * The OAuth beta flag, which must NOT be forwarded from here.
 *
 * `oauth-2025-04-20` is the flag that says "this request authenticates with a
 * Claude subscription OAuth bearer". This path authenticates with an org
 * `x-api-key`, so sending it asserts something untrue about the credential in
 * the very same request. The pass-through path forwards the beta list verbatim
 * for the opposite reason — there the assertion is true, and the set is part of
 * what the token is validated against.
 */
const OAUTH_BETA = "oauth-2025-04-20";

/** Drop the OAuth flag, keep the order and spelling of everything else. */
function forwardableBetas(raw: string | null): string | null {
  if (raw === null) return null;
  const kept = raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "" && v !== OAUTH_BETA);
  return kept.length === 0 ? null : kept.join(", ");
}

export const anthropicAdapter: Adapter = {
  id: "anthropic",

  transforms: [
    "model id rewritten to the configured id",
    "server-held API key substituted for the caller's credential",
    "Anthropic beta flags forwarded, except the OAuth one",
  ],

  plan(req: AdapterRequest): AdapterPlan {
    const url = joinUpstreamUrl(req.upstream.baseUrl, req.path);

    const headers = new Headers({
      // An org API key goes in x-api-key. Deliberately NOT `authorization`:
      // that is where a subscription bearer lives, and the two must never be
      // interchangeable in this codebase even by accident.
      "x-api-key": req.secret.expose(),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: req.stream ? "text/event-stream" : "application/json",
      "accept-encoding": "identity",
      "user-agent": "fest",
    });

    /**
     * Beta flags must ride along, because they are what makes the BODY legal.
     *
     * Claude Code sends top-level `context_management`, `output_config` and
     * `safeguards`, each gated by a beta in this header. Anthropic validates
     * the body strictly, so dropping the header does not degrade gracefully to
     * "feature off" — it fails the whole request with
     * `400 context_management: Extra inputs are not permitted`, on the first
     * message, for a model the developer legitimately selected.
     *
     * Unlike the Fireworks adapter, which drops these because its destination
     * cannot understand them, this destination IS Anthropic, so the flags mean
     * exactly what they say.
     */
    const betas = forwardableBetas(req.betas);
    if (betas !== null) headers.set("anthropic-beta", betas);

    return { url, headers, body: rewriteModel(req.body, req.servedModel) };
  },
};
