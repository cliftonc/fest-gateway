/**
 * The routing table, explained for a reader rather than for the router.
 *
 * A routing file does two quite different things with the same syntax, and
 * conflating them is how an operator misreads their own config:
 *
 *  - it **substitutes** — a model the developer already has a name for now
 *    comes from somewhere else, on a credential the server holds;
 *  - it **adds** — an id that exists nowhere but this gateway appears in the
 *    `/model` menu, and choosing it is a deliberate act.
 *
 * The first is the one that needs watching. The second is a feature. A single
 * table of `match → upstream` rows shows both as the same kind of line.
 *
 * Both classifications are derived by ASKING the real resolver and the real
 * menu builder, never by re-reading the pattern here. Pattern-reading would
 * ignore precedence: `claude-*` looks like it claims Opus right up until an
 * exact `claude-opus-5` rule sits above it, and a dashboard that said
 * otherwise would be confidently wrong in exactly the case an operator checks.
 */

import type { Route, RouteTable } from "../routes/table.ts";
import { claimsModel, evaluationOrder, resolveRoute } from "../routes/resolve.ts";
import { buildModelMenu } from "./models.ts";
import { BASE_MODELS } from "../../shared/base-models.ts";

export interface RouteExplanation {
  readonly route: Route;
  /** Base model ids that resolve through this rule. */
  readonly shadows: readonly string[];
  /**
   * Base model ids this rule covers but a more specific rule takes.
   *
   * `claude-sonnet-*` alongside an exact `claude-sonnet-5` rule is the case:
   * the exact rule wins today, but the wildcard is still a rule about Sonnet
   * and still claims every other Sonnet id, including the next one Anthropic
   * ships. Reporting it as a model this gateway *adds* would be wrong, and
   * dropping the fact that something else outranks it would be worse.
   */
  readonly outranked: readonly { readonly model: string; readonly takenBy: string }[];
  /** Menu ids this rule adds which Anthropic does not itself offer. */
  readonly menuIds: readonly string[];
}

/** Routes in evaluation order, each with what it claims and what it adds. */
export function explainRoutes(table: RouteTable): RouteExplanation[] {
  const baseIds = new Set(BASE_MODELS.map((m) => m.id));
  // What the client would actually be shown. An id Fest cannot serve in the key
  // posture is not in here, and must not be reported as a model this gateway
  // adds — the menu is a promise, and so is this screen.
  const menu = new Set(buildModelMenu(table).map((e) => e.id));

  return evaluationOrder(table).map((route) => {
    const shadows: string[] = [];
    const outranked: { model: string; takenBy: string }[] = [];
    for (const { id } of BASE_MODELS) {
      if (!claimsModel(route, id)) continue;
      const winner = resolveRoute(table, id).route;
      if (winner === route) shadows.push(id);
      else if (winner !== null) outranked.push({ model: id, takenBy: winner.id });
    }

    const menuIds = [route.match.includes("*") ? null : route.match, route.expose].filter(
      (id): id is string => id !== null && !baseIds.has(id) && menu.has(id),
    );

    return { route, shadows, outranked, menuIds };
  });
}
