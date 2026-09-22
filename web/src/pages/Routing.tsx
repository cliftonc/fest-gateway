/**
 * Routing — what Fest will do to a request, as configured.
 *
 * This screen answers "what will happen", where Stats answers "what did
 * happen". Both are needed: traffic tells you a substitution occurred, config
 * tells you one is *about* to — including for a model nobody has requested yet.
 *
 * It is deliberately several tables and not one, because a routing file does
 * three unrelated things with the same syntax:
 *
 *  1. **Upstreams** — the places traffic can go, and whether their credentials
 *     are actually set on this server.
 *  2. **Substitutions** — a model the developer already has a name for now
 *     comes from somewhere else. This is the one that needs watching, and the
 *     one that must never be a line an operator's eye slides over.
 *  3. **Added models** — ids that exist nowhere but this gateway. Choosing one
 *     is a deliberate act by the developer, so it is a feature, not a risk.
 *
 * A single `match → upstream` table renders (2) and (3) identically, which is
 * how an operator misreads their own config. The classification comes from the
 * server, which asks the real resolver — see `server/api/routing-view.ts`.
 *
 * Nothing secret can appear here. The server sends credential REFERENCES
 * (`env:FIREWORKS_API_KEY`) and a resolution status; there is no value in the
 * routing table to leak, because the config holds references by construction.
 *
 * `credentialPresent` gets a prominent warning rather than a quiet icon: a
 * route whose key is unset is not a degraded route, it is a route that will
 * refuse every request it matches, and the only other way to discover that is
 * for a developer to hit it mid-task.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.ts";
import type { RouteWire } from "../../../shared/api.ts";
import { Card, Muted, Pill, QueryState, Table, TableCell, TableRow } from "../components/ui.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";

/**
 * One id per line. These columns hold lists, and real model ids are long
 * enough that a comma-joined one wraps into an unreadable run of text.
 */
function Ids({ ids }: { ids: readonly string[] }): React.JSX.Element {
  return (
    <div className="mono flex flex-col gap-0.5">
      {ids.map((id) => (
        <span key={id}>{id}</span>
      ))}
    </div>
  );
}

/**
 * The Anthropic models a rule claims, with the ones another rule takes struck
 * through rather than hidden.
 *
 * Hiding them would make a broad rule look like it does nothing; listing them
 * plainly would say a developer asking for Sonnet lands here when they do not.
 * Struck through and named, it reads as what it is: in scope, currently
 * overridden.
 */
function Claimed({ route }: { route: RouteWire }): React.JSX.Element {
  if (route.shadows.length + route.outranked.length === 0) return <Muted>—</Muted>;
  return (
    <div className="mono flex flex-col gap-0.5">
      {route.shadows.map((id) => (
        <span key={id}>{id}</span>
      ))}
      {route.outranked.map((o) => (
        <Muted key={o.model} title={`Taken by the more specific rule “${o.takenBy}”, which wins regardless of file order. This rule still claims every other id its pattern matches.`}>
          <span className="line-through">{o.model}</span>
        </Muted>
      ))}
    </div>
  );
}

/** Where a rule sends what it matched. */
const Destination = ({ route }: { route: RouteWire }): React.JSX.Element =>
  route.upstream === null ? (
    <Pill tone="ok" title="Deliberately kept on the caller's own credential.">
      pass through
    </Pill>
  ) : (
    <Pill tone="warn" title="Served on a credential the server holds — org spend.">
      {route.upstream}
    </Pill>
  );

const SentAs = ({ route }: { route: RouteWire }): React.JSX.Element =>
  route.model === null ? <Muted>unchanged</Muted> : <span className="mono">{route.model}</span>;

export function RoutingPage(): React.JSX.Element {
  const routing = useQuery({
    queryKey: ["routing"],
    // Config only changes on restart or a hot reload, so polling it is waste.
    queryFn: api.routing,
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });

  const data = routing.data;
  const upstreams = data?.upstreams ?? [];
  const routes = data?.routes ?? [];
  const broken = upstreams.filter((u) => !u.credentialPresent);

  /*
   * Disjoint by construction, in this order, so every rule appears exactly
   * once: a carve-out is a carve-out whatever it matches; a rule that covers a
   * model Anthropic already offers is a substitution even when it also
   * publishes an alias (which gets its own column); everything else only adds.
   *
   * "Covers" includes a wildcard whose base-model id a more specific rule takes
   * today: `claude-sonnet-*` is a rule about Sonnet whether or not an exact
   * `claude-sonnet-5` sits above it, and it still claims every other Sonnet id
   * — including the next one Anthropic ships. Filing it under "models this
   * gateway adds" would be the misreading this split exists to prevent.
   */
  const substitutes = (r: RouteWire): boolean => r.shadows.length + r.outranked.length > 0;
  const passThrough = routes.filter((r) => r.upstream === null);
  const substitutions = routes.filter((r) => r.upstream !== null && substitutes(r));
  const additions = routes.filter((r) => r.upstream !== null && !substitutes(r));

  const pending = routing.isPending;
  const notConfigured = data !== undefined && !data.enabled;
  /**
   * With no table loaded there are no rules to classify, and three cards each
   * saying "no rule does this" reads as three findings rather than one fact.
   * The upstreams card carries the single explanation.
   */
  const showRules = pending || data?.enabled === true;

  return (
    <>
      {broken.length > 0 && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            {broken.map((u) => u.credentialSource).join(", ")}{" "}
            {broken.length === 1 ? "is" : "are"} not set on the Fest server. Every request matching
            a route that targets {broken.length === 1 ? "this upstream" : "these upstreams"} will be{" "}
            <strong>refused</strong> — Fest will not quietly serve it on a developer's subscription
            instead.
          </AlertDescription>
        </Alert>
      )}

      <Card
        title="Upstreams"
        subtitle="Where traffic can go, and whether this server can actually reach it. Credentials are shown as references — the config holds {env:NAME}, never a value, so there is nothing secret on this screen to redact."
        right={
          data === undefined ? undefined : (
            <Pill tone={data.enabled ? "info" : "muted"} title={`table version ${data.version}`}>
              {data.enabled ? `v${data.version.slice(0, 8)}` : "not configured"}
            </Pill>
          )
        }
      >
        <QueryState
          isPending={pending}
          error={routing.error}
          isEmpty={notConfigured}
          emptyText="No routing configured. Every request passes through to Anthropic on the caller's own credential — the safe default. Set FEST_ROUTES to change that."
        >
          <Table head={["Upstream", "Adapter", "Endpoint", "Credential", "Rules", "Transforms"]}>
            {upstreams.map((u) => {
              const using = routes.filter((r) => r.upstream === u.id);
              return (
                <TableRow key={u.id}>
                  <TableCell>{u.id}</TableCell>
                  <TableCell>{u.adapter}</TableCell>
                  <TableCell className="mono">{u.baseUrl}</TableCell>
                  <TableCell>
                    <span className="mono">{u.credentialSource}</span>{" "}
                    <Pill tone={u.credentialPresent ? "ok" : "bad"}>
                      {u.credentialPresent ? "set" : "not set"}
                    </Pill>
                  </TableCell>
                  <TableCell className="num">
                    {using.length === 0 ? (
                      // Only reachable for the `anthropic` adapter, which serves
                      // unrouted Anthropic models in the key posture; the config
                      // parser rejects any other dead upstream at boot.
                      <Muted title="No rule targets this upstream. An anthropic adapter is still reachable as the default for unrouted Anthropic models in the key posture.">
                        default only
                      </Muted>
                    ) : (
                      using.length
                    )}
                  </TableCell>
                  <TableCell>
                    <Muted>{u.transforms.join("; ")}</Muted>
                  </TableCell>
                </TableRow>
              );
            })}
          </Table>
        </QueryState>
      </Card>

      {showRules && (
        <Card
          title="Substitutions"
          subtitle="Rules that change where a model Anthropic already offers comes from. A developer asks for it by its usual name and gets it from somewhere else, on a credential the server holds — which is org spend, and the reason this screen exists."
        >
          <QueryState
            isPending={pending}
            error={routing.error}
            isEmpty={substitutions.length === 0}
            emptyText="No rule claims a model Anthropic offers. Every base model still resolves the way a developer would expect."
          >
            <Table
              head={["Rule", "Pattern", "Substitutes for", "Goes to", "Sent as", "Also listed as"]}
            >
              {substitutions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.id}</TableCell>
                  <TableCell className="mono">{r.match}</TableCell>
                  <TableCell>
                    <Claimed route={r} />
                  </TableCell>
                  <TableCell>
                    <Destination route={r} />
                  </TableCell>
                  <TableCell>
                    <SentAs route={r} />
                  </TableCell>
                  <TableCell>
                    {r.menuIds.length === 0 ? (
                      <Muted title="Claude Code dedupes gateway entries against its built-in list, so a substituted id shows no destination in the picker. An expose alias is how a developer gets to see where it goes.">
                        no alias
                      </Muted>
                    ) : (
                      <Ids ids={r.menuIds} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </QueryState>
        </Card>
      )}

      {showRules && (
        <Card
          title="Models this gateway adds"
          subtitle="Ids that exist only behind Fest. They take nothing away from a developer: they appear under “From gateway” in the /model menu, and choosing one is a deliberate act."
        >
          <QueryState
            isPending={pending}
            error={routing.error}
            isEmpty={additions.length === 0}
            emptyText="No rule adds a model. Routing here only changes where existing models come from."
          >
            <Table head={["Rule", "Pattern", "Appears in /model as", "Goes to", "Sent as"]}>
              {additions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.id}</TableCell>
                  <TableCell className="mono">{r.match}</TableCell>
                  <TableCell>
                    {r.menuIds.length === 0 ? (
                      // A pattern has no single id to publish, and the client
                      // drops any id that does not look Anthropic-ish. Either
                      // way the rule still routes — it just has to be asked for.
                      <Muted title="Not published in the menu: a wildcard has no single id to list, and Claude Code drops any id not matching /(claude|anthropic)/i. The rule still applies to a request that asks for a matching id.">
                        not listed — request by id
                      </Muted>
                    ) : (
                      <Ids ids={r.menuIds} />
                    )}
                  </TableCell>
                  <TableCell>
                    <Destination route={r} />
                  </TableCell>
                  <TableCell>
                    <SentAs route={r} />
                  </TableCell>
                </TableRow>
              ))}
            </Table>
          </QueryState>
        </Card>
      )}

      {passThrough.length > 0 && (
        <Card
          title="Kept on the caller's credential"
          subtitle="Carve-outs: rules that match, and then deliberately do nothing. This is how a broad substitution keeps its exceptions on a developer's own subscription."
        >
          <Table head={["Rule", "Pattern", "Substitutes for", "Goes to"]}>
            {passThrough.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.id}</TableCell>
                <TableCell className="mono">{r.match}</TableCell>
                <TableCell>
                  <Claimed route={r} />
                </TableCell>
                <TableCell>
                  <Destination route={r} />
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </Card>
      )}

      {routes.length > 0 && (
        <p className="max-w-[70ch] text-xs text-muted-foreground">
          Rules are listed in <strong>evaluation order</strong> within each table — exact matches
          first, then longest wildcard, then file order. That is not the order they appear in the
          file, and “substitutes for” already has precedence applied: a catch-all is not credited
          with a model an exact rule above it takes.
        </p>
      )}
    </>
  );
}
