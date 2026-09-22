/**
 * How to point Claude Code at this gateway — always reachable, but only in the
 * way each reader needs.
 *
 * A gateway's dashboard is unreadable before any traffic exists: every panel is
 * a zero and none of them say why. So for a developer who has sent nothing this
 * opens expanded, because it answers the only question they have — what do I
 * type. For everyone else it collapses to a `Setup CLI` button, since the same
 * three commands are what you need again on a second machine, and hiding them
 * entirely would mean going to find the README.
 *
 * It shows the SUBSCRIPTION path deliberately, and only that one. Fest's point
 * is that each developer authenticates with their own Claude subscription, so
 * that is the path worth teaching first; the org-credential route exists but
 * needs an operator to have configured routing, and offering both here would
 * ask a reader to choose before they know the difference.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronUp, KeyRound, Rocket, Terminal } from "lucide-react";
import { api } from "../lib/api.ts";
import { BASE_URL } from "../lib/base.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { Button } from "./ui/button.tsx";

/** Remembers a deliberate open/close, so the default only applies until then. */
const EXPANDED_KEY = "fest-setup-cli-expanded";

function storedPreference(): boolean | null {
  const raw = localStorage.getItem(EXPANDED_KEY);
  return raw === "1" ? true : raw === "0" ? false : null;
}

/**
 * Deliberately not the dashboard's range picker. The question is "has this
 * person ever used the gateway", and answering it from a five-minute live
 * window would put setup instructions in front of someone mid-session.
 * Requests are retained 30 days, so this is as close to "ever" as the data goes.
 */
const LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/** The gateway's address as this browser reached it, mount path and all. */
function serverUrl(): string {
  return BASE_URL.replace(/\/+$/, "");
}

export interface SetupCliState {
  readonly hasSessions: boolean;
  readonly expanded: boolean;
  readonly setExpanded: (next: boolean) => void;
}

/**
 * The open/closed state, held here so the toggle can live in the page header
 * while the panel renders below it. They are in different parents, so sharing
 * by composition is not available — a hook is.
 *
 * Returns null until the answer is known. Opening this at someone who has been
 * using Fest for a month, even for one frame, is worse than a moment of
 * nothing, and a toggle appearing late would shift the header as it resolved.
 */
export function useSetupCli(userId: string | undefined): SetupCliState | null {
  const [preference, setPreference] = useState<boolean | null>(storedPreference);

  const now = Date.now();
  const users = useQuery({
    queryKey: ["setup-cli-usage", userId],
    queryFn: () => api.users({ fromMs: now - LOOKBACK_MS, toMs: now }),
    enabled: userId !== undefined,
    staleTime: 60_000,
  });

  if (userId === undefined || !users.isSuccess) return null;

  const mine = users.data.rows.find((r) => r.userId === userId);
  const hasSessions = mine !== undefined && mine.requests > 0;

  return {
    hasSessions,
    // A stated preference wins; otherwise having no traffic is what opens it.
    expanded: preference ?? !hasSessions,
    setExpanded: (next: boolean): void => {
      localStorage.setItem(EXPANDED_KEY, next ? "1" : "0");
      setPreference(next);
    },
  };
}

/** Sits in the page header beside the range picker, so it costs no vertical space. */
export function SetupCliToggle({ state }: { state: SetupCliState }): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-expanded={state.expanded}
      onClick={() => state.setExpanded(!state.expanded)}
    >
      <Terminal className="size-3.5" />
      Setup CLI
    </Button>
  );
}

export function SetupCliPanel({ state }: { state: SetupCliState }): React.JSX.Element | null {
  if (!state.expanded) return null;

  const { hasSessions, setExpanded } = state;
  const server = serverUrl();

  const steps = [
    {
      icon: Terminal,
      title: "Install the CLI",
      body: "Node 22.18 or newer. The package is fest-gateway; the command is fest.",
      command: "npm install -g fest-gateway",
    },
    {
      icon: KeyRound,
      title: "Sign in to this gateway",
      body: "Opens a browser, then stores an identity token in ~/.fest. This is what attributes your usage to you.",
      command: `fest login --server ${server}`,
    },
    {
      icon: Rocket,
      title: "Start a session",
      body: "Runs Claude Code with the environment already pointed here. Your own subscription pays, and Fest never stores your credential.",
      command: "fest claude",
    },
  ];

  return (
    <section
      aria-labelledby="setup-cli-heading"
      className="relative mb-5 overflow-hidden rounded-xl bg-card ring-1 ring-status-sub/30"
    >
      {/* A wash of the subscription tone rather than a solid fill: this is an
          invitation, not a warning, and a fully saturated panel would read as
          an error on a dashboard where colour already means severity. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-status-sub/8 via-transparent to-transparent"
      />

      <div className="relative p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="setup-cli-heading" className="text-base font-semibold text-foreground">
              Point Claude Code at Fest
            </h2>
            <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
              {hasSessions
                ? "Three commands to run Claude Code through this gateway — on a new machine, or for someone you are setting up."
                : "Nothing has come through on your account yet. Three commands and your next Claude Code session runs through this gateway — on your own subscription, metered here."}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label="Hide setup instructions"
            aria-expanded
            onClick={() => setExpanded(false)}
            className="-mt-1 shrink-0 text-muted-foreground"
          >
            <ChevronUp className="size-4" />
            Hide
          </Button>
        </div>

        <ol className="mt-4 grid gap-3 md:grid-cols-3">
          {steps.map((step, i) => (
            <li
              key={step.title}
              className="flex flex-col gap-2 rounded-lg bg-background/40 p-3 ring-1 ring-foreground/5"
            >
              <div className="flex items-center gap-2">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-status-sub/15 text-[11px] font-semibold text-status-sub">
                  {i + 1}
                </span>
                <step.icon className="size-3.5 shrink-0 text-status-sub" />
                <h3 className="truncate text-[13px] font-medium text-foreground">{step.title}</h3>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">{step.body}</p>
              <CopyCommand command={step.command} className="mt-auto" />
            </li>
          ))}
        </ol>

        {/* The one thing that silently defeats the whole design, so it is on the
            screen rather than in the docs: either variable makes Claude Code
            send an API key, which bills the org and bypasses the subscription
            this page just finished explaining. */}
        <p className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
          <Check className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
          <span>
            Make sure <code className="mono text-foreground">ANTHROPIC_API_KEY</code> and{" "}
            <code className="mono text-foreground">ANTHROPIC_AUTH_TOKEN</code> are unset — either
            one drops you off your own subscription onto whatever credential this server holds.
          </span>
        </p>
      </div>
    </section>
  );
}
