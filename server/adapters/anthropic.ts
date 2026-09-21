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

export const anthropicAdapter: Adapter = {
  id: "anthropic",

  transforms: [
    "model id rewritten to the configured id",
    "server-held API key substituted for the caller's credential",
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

    return { url, headers, body: rewriteModel(req.body, req.servedModel) };
  },
};
