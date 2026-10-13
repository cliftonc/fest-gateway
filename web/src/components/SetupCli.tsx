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
 * Install and sign-in are the same whichever agent a developer uses; only the
 * command that starts a session differs. So a Claude Code | Codex | Copilot
 * switch changes step 3 and the one caveat under it, and nothing else.
 *
 * For each agent it shows the path where the developer's OWN credential pays,
 * and only that one. Fest's point is per-developer pass-through; the
 * org-credential variants (`gw`) exist but need an operator to have configured
 * routing, and offering both here would ask a reader to choose before they know
 * the difference.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronUp, KeyRound, Rocket, Terminal } from "lucide-react";
import { api } from "../lib/api.ts";
import { BASE_URL } from "../lib/base.ts";
import { CopyCommand } from "./CopyCommand.tsx";
import { Button } from "./ui/button.tsx";
import { ButtonGroup } from "./ui/button-group.tsx";

/** Remembers a deliberate open/close, so the default only applies until then. */
const EXPANDED_KEY = "fest-setup-cli-expanded";

/** Remembers which agent the reader picked, so it is not reset on every visit. */
const CLIENT_KEY = "fest-setup-cli-client";

type ClientId = "claude" | "codex" | "copilot";

const Code = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <code className="mono text-foreground">{children}</code>
);

/** Everything that differs per agent: the session step, and its one caveat. */
const CLIENTS: ReadonlyArray<{
  readonly id: ClientId;
  readonly label: string;
  readonly name: string;
  readonly body: string;
  readonly command: string;
  readonly note: React.ReactNode;
}> = [
  {
    id: "claude",
    label: "Claude Code",
    name: "Claude Code",
    body: "Runs Claude Code with the environment already pointed here. Your own subscription pays, and Fest never stores your credential.",
    command: "fest claude",
    // The one thing that silently defeats the whole design, so it is on the
    // screen rather than in the docs: either variable makes Claude Code send an
    // API key, which bills the org and bypasses the subscription.
    note: (
      <>
        Make sure <Code>ANTHROPIC_API_KEY</Code> and <Code>ANTHROPIC_AUTH_TOKEN</Code> are unset —
        either one drops you off your own subscription onto whatever credential this server holds.
      </>
    ),
  },
  {
    id: "codex",
    label: "Codex",
    name: "Codex",
    body: "Runs Codex on its own login, pointed here. A ChatGPT login means your plan pays; an API key means its owner does. Your ~/.codex config is left untouched.",
    command: "fest codex",
    note: (
      <>
        Sign in to Codex first with <Code>codex login</Code>. On a machine with a ChatGPT login,{" "}
        <Code>fest codex key</Code> uses your <Code>OPENAI_API_KEY</Code> instead.
      </>
    ),
  },
  {
    id: "copilot",
    label: "Copilot",
    name: "Copilot CLI",
    body: "Runs Copilot CLI in bring-your-own-key mode with Fest as its provider. Your API key pays — never your Copilot seat, whose traffic Fest does not relay.",
    command: "fest copilot",
    note: (
      <>
        Set <Code>ANTHROPIC_API_KEY</Code> to an API key, not a Claude subscription token. Without one,{" "}
        <Code>fest copilot gw</Code> uses this gateway&apos;s own routes.
      </>
    ),
  },
];

function storedClient(): ClientId {
  const raw = localStorage.getItem(CLIENT_KEY);
  return CLIENTS.some((c) => c.id === raw) ? (raw as ClientId) : "claude";
}

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
  const [clientId, setClientId] = useState<ClientId>(storedClient);
  if (!state.expanded) return null;

  const { hasSessions, setExpanded } = state;
  const server = serverUrl();
  const client = CLIENTS.find((c) => c.id === clientId) ?? CLIENTS[0]!;
  const pickClient = (id: ClientId): void => {
    localStorage.setItem(CLIENT_KEY, id);
    setClientId(id);
  };

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
      body: client.body,
      command: client.command,
    },
  ];

  return (
    <section
      aria-labelledby="setup-cli-heading"
      className="relative mb-5 overflow-hidden rounded-lg bg-card ring-1 ring-status-sub/30"
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
            <h2 id="setup-cli-heading" className="text-base font-medium text-foreground">
              Point {client.name} at Fest
            </h2>
            <p className="mt-1 max-w-[68ch] text-[13px] text-muted-foreground">
              {hasSessions
                ? `Three commands to run ${client.name} through this gateway — on a new machine, or for someone you are setting up.`
                : `Nothing has come through on your account yet. Three commands and your next ${client.name} session runs through this gateway, metered here.`}
            </p>
          </div>
          {/* `aria-pressed`, as on the Live controls: three tabbable buttons
              read correctly without a radiogroup's roving focus. */}
          <ButtonGroup aria-label="Coding agent" className="-mt-1 shrink-0">
            {CLIENTS.map((c) => (
              <Button
                key={c.id}
                type="button"
                size="sm"
                variant={c.id === clientId ? "default" : "outline"}
                aria-pressed={c.id === clientId}
                onClick={() => pickClient(c.id)}
              >
                {c.label}
              </Button>
            ))}
          </ButtonGroup>
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

        <p className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
          <Check className="mt-0.5 size-3.5 shrink-0 text-status-ok" />
          <span>{client.note}</span>
        </p>
      </div>
    </section>
  );
}
