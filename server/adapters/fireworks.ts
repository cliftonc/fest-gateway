/**
 * Fireworks.
 *
 * The important discovery, and the reason this adapter is twenty lines of
 * substance rather than a wire-format translator: **Fireworks serves an
 * Anthropic-compatible Messages API**. `fireconnect` points Claude Code
 * straight at `https://api.fireworks.ai/inference` as `ANTHROPIC_BASE_URL`,
 * which only works if `/v1/messages` speaks the Anthropic request and SSE
 * format. So there is no Anthropic↔OpenAI translation here, and — critically —
 * no need to re-frame the event stream, which means the existing SSE parser and
 * usage accumulator keep working unchanged on this path.
 *
 * What the adapter therefore does:
 *
 *  - swaps the base URL,
 *  - swaps the credential to the server-held one (`Authorization: Bearer`),
 *  - rewrites the `model` field to the provider's id.
 *
 * That last one is the only body edit, and it is why this path is allowed to
 * re-serialise the body at all: the request is going to a different vendor on a
 * different credential, so there is no Anthropic-issued OAuth token whose
 * signature depends on the exact bytes. The byte-for-byte rule protects the
 * subscription path; it does not apply here, and pretending otherwise would
 * make model rewriting impossible.
 *
 * ⚠ Not yet verified against the live API — there was no Fireworks key
 * available when this was written. The compatibility claim is inferred from
 * `fireconnect`'s configuration, which is strong evidence but not a test.
 * Integration tests run against a mock. See docs/PHASE4.md.
 */

import type { Adapter, AdapterPlan, AdapterRequest } from "./index.ts";
import { rewriteModel } from "./rewrite.ts";
import { joinUpstreamUrl } from "./url.ts";

export const fireworksAdapter: Adapter = {
  id: "fireworks",

  transforms: [
    "model id rewritten to the provider's id",
    "server-held credential substituted for the caller's",
    "Anthropic-specific beta headers dropped",
  ],

  plan(req: AdapterRequest): AdapterPlan {
    const url = joinUpstreamUrl(req.upstream.baseUrl, req.path);

    const headers = new Headers({
      // Fireworks authenticates with a bearer, not Anthropic's x-api-key.
      authorization: `Bearer ${req.secret.expose()}`,
      "content-type": "application/json",
      accept: req.stream ? "text/event-stream" : "application/json",
      // The tee needs unencoded bytes to meter, exactly as on the other path.
      "accept-encoding": "identity",
      "user-agent": "fest",
    });

    return { url, headers, body: rewriteModel(req.body, req.servedModel) };
  },
};
