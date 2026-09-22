/**
 * Provider adapters.
 *
 * An adapter's job is narrow by construction: given a validated request that is
 * already in Anthropic Messages shape, produce the URL, headers and body to
 * send to one provider, and describe how to read usage back.
 *
 * Note what an adapter is NOT allowed to be used for: the pass-through pipeline
 * does not go through this interface at all. Adapters exist to transform;
 * `pipeline/passthrough.ts` exists precisely not to. Keeping them apart is what
 * makes "bytes are forwarded verbatim on the subscription path" a structural
 * property rather than a convention someone can erode one helpful rewrite at a
 * time.
 */

import type { UsagePayload } from "../../shared/types.ts";
import type { NonPersistable } from "../secret/non-persistable.ts";
import type { Upstream } from "../routes/table.ts";

export interface AdapterRequest {
  /** The inbound path, already stripped of any Fest identity prefix. */
  readonly path: string;
  /** The inbound body, verbatim. An adapter may replace it; most should not. */
  readonly body: Uint8Array<ArrayBuffer>;
  /** The model to send, after any route rewrite. */
  readonly servedModel: string | null;
  /**
   * The inbound `anthropic-beta` value, verbatim, or null.
   *
   * This is the ONLY inbound header an adapter sees, and the narrowness is the
   * point: a plan is built from scratch precisely so a caller's credential
   * cannot be copied onto it by accident, and handing over the whole header bag
   * would turn that structural guarantee back into a matter of discipline.
   *
   * It is here because Claude Code's body is shaped by these flags — it sends
   * top-level `context_management`, `output_config` and `safeguards`, and
   * Anthropic's API rejects an unrecognised top-level field outright
   * (`400 context_management: Extra inputs are not permitted`). A provider that
   * does not understand Anthropic betas should ignore this.
   */
  readonly betas: string | null;
  readonly stream: boolean;
  readonly secret: NonPersistable<string>;
  readonly upstream: Upstream;
}

export interface AdapterPlan {
  readonly url: URL;
  readonly headers: Headers;
  readonly body: Uint8Array<ArrayBuffer>;
}

export interface Adapter {
  readonly id: string;
  /**
   * Human-readable note for the dashboard: what this adapter changes about a
   * request. Rendered next to the route so an operator can see the cost of the
   * substitution without reading the source.
   */
  readonly transforms: readonly string[];
  plan(req: AdapterRequest): AdapterPlan;
  /** Read usage from a non-streaming response body, if this provider reports it. */
  readUsage?(json: unknown): UsagePayload | null;
}
