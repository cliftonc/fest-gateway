/**
 * Routing — where a request went, and whose credential paid for it.
 *
 * It answers one question an admin should never have to dig for: whose
 * credential paid for this traffic. `inbound_subscription` means the
 * developer's own Max/Team plan absorbed it and the org spent nothing;
 * `fallback_server` means Fest substituted a key the server holds, which is
 * real org spend and must never happen quietly.
 *
 * Quota, not dollars, leads here. On a subscription the marginal cost of a
 * request is zero and the scarce resource is the rate-limit window, so the
 * actionable number is 5h/7d utilisation and which window is currently binding
 * — which Anthropic hands us on every response, exactly, with no price table
 * involved.
 */

import { useQuery } from "@tanstack/react-query";
import { api, type Range } from "../lib/api.ts";
import {
  Card,
  Meter,
  Muted,
  Pill,
  QueryState,
  Stat,
  StatRow,
  Table,
  TableCell,
  TableRow,
  TONE_TEXT,
} from "../components/ui.tsx";
import { Alert, AlertDescription } from "../components/ui/alert.tsx";
import { Legend, useOriginColors, ORIGIN_ORDER, PostureChart } from "../components/charts.tsx";
import { RoutingCard } from "../components/RoutingCard.tsx";
import { ORIGIN_LABELS, costTotal, num, originLabel, personLabel, ratio, relative, tokens, when } from "../lib/format.ts";

/** Above this, a developer is close enough to the wall to warn about. */
const WARN_AT = 0.8;
const BAD_AT = 0.95;

const utilTone = (v: number | null): "ok" | "warn" | "bad" | "muted" =>
  v === null ? "muted" : v >= BAD_AT ? "bad" : v >= WARN_AT ? "warn" : "ok";

/** `Meter` has no "unknown" fill, so an unknown utilisation draws as neutral. */
const meterTone = (v: number | null): "ok" | "warn" | "bad" | "info" =>
  v === null ? "info" : v >= BAD_AT ? "bad" : v >= WARN_AT ? "warn" : "ok";

export function RoutingPage({ range }: { range: Range }): React.JSX.Element {
  const originColors = useOriginColors();
  const overview = useQuery({
    queryKey: ["overview", range.fromMs, range.toMs],
    queryFn: () => api.overview(range),
  });
  const quota = useQuery({ queryKey: ["quota"], queryFn: api.quota });

  const origins = overview.data?.byCredentialOrigin ?? [];
  const totalRequests = origins.reduce((a, r) => a + r.requests, 0);
  const share = (id: string): number =>
    totalRequests === 0 ? 0 : (origins.find((o) => o.credentialOrigin === id)?.requests ?? 0) / totalRequests;

  const serverKeyRequests = origins.find((o) => o.credentialOrigin === "fallback_server")?.requests ?? 0;
  const totals = overview.data?.totals;

  return (
    <>
      {serverKeyRequests > 0 && (
        <Alert variant="warning" className="mb-4">
          <AlertDescription>
            {num(serverKeyRequests)} request{serverKeyRequests === 1 ? "" : "s"} in this range ran
            on a <strong>server-held key</strong> rather than a developer's own subscription. That
            is org spend, and it is billed to whoever owns that key — check the Models screen for
            which model triggered the substitution.
          </AlertDescription>
        </Alert>
      )}

      <Card
        title="Who paid for this traffic"
        subtitle="Subscription usage and metered spend are shown side by side and never added: a request a developer's own plan absorbed cost the org nothing, which is not the same as costing zero."
      >
        <QueryState
          isPending={overview.isPending}
          error={overview.error}
          isEmpty={totalRequests === 0}
        >
          <StatRow>
            <Stat
              label="On own subscription"
              value={ratio(share("inbound_subscription"))}
              note={`${num(origins.find((o) => o.credentialOrigin === "inbound_subscription")?.requests ?? 0)} requests`}
              tone="ok"
            />
            <Stat
              label="On a server-held key"
              value={ratio(share("fallback_server"))}
              note={`${num(serverKeyRequests)} requests`}
              tone={serverKeyRequests > 0 ? "warn" : "muted"}
            />
            <Stat
              label="Org spend"
              value={totals === undefined ? "—" : costTotal(totals)}
              note="metered requests only"
            />
            <Stat
              label="Absorbed by subscriptions"
              value={num(totals?.subscriptionRequests ?? 0)}
              note="real usage, no org spend"
              tone="muted"
            />
          </StatRow>

          <PostureChart rows={origins} />
          <Legend
            items={ORIGIN_ORDER.filter((o) =>
              origins.some((r) => r.credentialOrigin === o && r.requests > 0),
            ).map((o) => ({ label: ORIGIN_LABELS[o] ?? o, color: originColors[o] ?? "" }))}
          />

          <Table head={["Credential origin", "Requests", "People", "Errors", "Tokens", "Cost"]}>
            {origins.map((row) => (
              <TableRow key={row.credentialOrigin}>
                <TableCell>
                  <Pill tone={row.credentialOrigin === "inbound_subscription" ? "ok" : row.credentialOrigin === "fallback_server" ? "warn" : "muted"}>
                    {originLabel(row.credentialOrigin)}
                  </Pill>
                </TableCell>
                <TableCell className="num">{num(row.requests)}</TableCell>
                <TableCell className="num">{num(row.distinctUsers)}</TableCell>
                <TableCell className="num">{row.errors === 0 ? <Muted>0</Muted> : row.errors}</TableCell>
                <TableCell className="num">
                  {tokens(
                    row.usage.inputTokens +
                      row.usage.cacheReadTokens +
                      row.usage.cacheWrite5mTokens +
                      row.usage.cacheWrite1hTokens +
                      row.usage.outputTokens,
                  )}
                </TableCell>
                <TableCell className="num">
                  {row.subscriptionRequests === row.requests ? (
                    <Muted title="A subscription absorbed every request in this row, so no dollar figure applies.">
                      subscription
                    </Muted>
                  ) : (
                    costTotal(row)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>

      <RoutingCard />

      <Card
        title="Rate-limit headroom, per developer"
        subtitle="The latest quota Anthropic reported for each person. This is the scarce resource on a subscription — not money. It reads raw request rows, so it empties as retention removes them."
      >
        <QueryState
          isPending={quota.isPending}
          error={quota.error}
          isEmpty={(quota.data?.rows.length ?? 0) === 0}
          emptyText="No quota headers observed yet. They arrive on every subscription response, so this fills in as soon as someone runs a turn."
        >
          <Table head={["Developer", "5-hour window", "7-day window", "Binding", "Overage", "Observed"]}>
            {(quota.data?.rows ?? []).map((row) => (
              <TableRow key={row.userId ?? "unattributed"}>
                <TableCell>{personLabel(row.userId, row.email)}</TableCell>
                <TableCell>
                  <span className={TONE_TEXT[utilTone(row.fiveHourUtilization)]}>
                    {ratio(row.fiveHourUtilization)}
                  </span>
                  <Meter value={row.fiveHourUtilization} tone={meterTone(row.fiveHourUtilization)} label="5-hour utilisation" />
                  <Muted>resets {relative(row.fiveHourResetAt)}</Muted>
                </TableCell>
                <TableCell>
                  <span className={TONE_TEXT[utilTone(row.sevenDayUtilization)]}>
                    {ratio(row.sevenDayUtilization)}
                  </span>
                  <Meter value={row.sevenDayUtilization} tone={meterTone(row.sevenDayUtilization)} label="7-day utilisation" />
                  <Muted>resets {relative(row.sevenDayResetAt)}</Muted>
                </TableCell>
                <TableCell>{row.claim === null ? <Muted>n/a</Muted> : <Pill tone="info">{row.claim}</Pill>}</TableCell>
                <TableCell>
                  {row.overageStatus === null ? (
                    <Muted>n/a</Muted>
                  ) : (
                    <Pill tone={row.overageStatus === "allowed" ? "ok" : "warn"} title={row.overageReason ?? undefined}>
                      {row.overageStatus}
                    </Pill>
                  )}
                </TableCell>
                <TableCell><Muted>{when(row.observedAt)}</Muted></TableCell>
              </TableRow>
            ))}
          </Table>
        </QueryState>
      </Card>
    </>
  );
}
