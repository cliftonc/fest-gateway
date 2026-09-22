/**
 * The routing table, as configured.
 *
 * This answers "what will Fest do", where the rest of the posture screen
 * answers "what did Fest do". Both are needed: traffic tells you a
 * substitution happened, config tells you one is *about* to — including for a
 * model nobody has requested yet.
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
import { Card, Muted, Pill, QueryState, Table, TableCell, TableRow } from "./ui.tsx";
import { Alert, AlertDescription } from "./ui/alert.tsx";

export function RoutingCard(): React.JSX.Element {
  const routing = useQuery({
    queryKey: ["routing"],
    // Config only changes on restart, so polling it is waste.
    queryFn: api.routing,
    staleTime: 5 * 60_000,
    refetchInterval: false,
  });

  const data = routing.data;
  const broken = (data?.upstreams ?? []).filter((u) => !u.credentialPresent);

  return (
    <Card
      title="Routing"
      subtitle="What Fest will do, as configured. Credentials are shown as references — the config holds {env:NAME}, never a value, so there is nothing secret on this screen to redact."
      right={
        data === undefined ? undefined : (
          <Pill tone={data.enabled ? "info" : "muted"} title={`table version ${data.version}`}>
            {data.enabled ? `v${data.version.slice(0, 8)}` : "not configured"}
          </Pill>
        )
      }
    >
      <QueryState
        isPending={routing.isPending}
        error={routing.error}
        isEmpty={data !== undefined && !data.enabled}
        emptyText="No routing configured. Every request passes through to Anthropic on the caller's own credential — the safe default. Set FEST_ROUTES to change that."
      >
        {broken.length > 0 && (
          <Alert variant="destructive" className="mb-4">
            <AlertDescription>
              {broken.map((u) => u.credentialSource).join(", ")}{" "}
              {broken.length === 1 ? "is" : "are"} not set on the Fest server. Every request
              matching a route that targets{" "}
              {broken.length === 1 ? "this upstream" : "these upstreams"} will be{" "}
              <strong>refused</strong> — Fest will not quietly serve it on a developer's
              subscription instead.
            </AlertDescription>
          </Alert>
        )}

        <Table head={["Upstream", "Adapter", "Endpoint", "Credential", "Transforms"]}>
          {(data?.upstreams ?? []).map((u) => (
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
              <TableCell>
                <Muted>{u.transforms.join("; ")}</Muted>
              </TableCell>
            </TableRow>
          ))}
        </Table>

        <p className="mt-4 mb-1.5 text-xs text-muted-foreground">
          Rules in <strong>evaluation order</strong> — exact matches first, then longest wildcard,
          then file order. This is not the order they appear in the file.
        </p>

        <Table head={["Route", "Matches", "Goes to", "Sent as"]}>
          {(data?.routes ?? []).map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.id}</TableCell>
              <TableCell className="mono">{r.match}</TableCell>
              <TableCell>
                {r.upstream === null ? (
                  <Pill tone="ok" title="Deliberately kept on the caller's own credential.">
                    pass through
                  </Pill>
                ) : (
                  <Pill tone="warn" title="Served on a credential the server holds — org spend.">
                    {r.upstream}
                  </Pill>
                )}
              </TableCell>
              <TableCell className="mono">
                {r.model === null ? <Muted>unchanged</Muted> : r.model}
              </TableCell>
            </TableRow>
          ))}
        </Table>
      </QueryState>
    </Card>
  );
}
