#!/usr/bin/env node
/**
 * `npm run dev` — the gateway and the dashboard, together, in one terminal.
 *
 * Runs two children:
 *
 *   1. `node --watch server/bin/fest.ts` — the gateway, on FEST_PORT (8787).
 *      `--watch` restarts it on a server file change; Node strips the types
 *      natively, so there is still no build step.
 *   2. `vite` — the dashboard on 5173, proxying `/api` to the gateway, with
 *      hot module replacement.
 *
 * Open **http://127.0.0.1:5173** — not `localhost:5173`: cookies are scoped by
 * hostname, not resolved address, so `localhost` and `127.0.0.1` are different
 * cookie domains even on the same machine. OAuth's state cookie is set while
 * browsing through the Vite proxy, then presented again when the provider
 * redirects straight back to the gateway's own `127.0.0.1:8787` — if those two
 * legs disagree on hostname, that cookie never arrives and sign-in fails with
 * "invalid or expired sign-in attempt" on the first attempt (and then
 * "succeeds" on a retry launched from the gateway's own origin, which is
 * consistent — the inconsistency was the bug).
 *
 * Point Claude Code at **8787**. Two ports
 * rather than one because HMR needs Vite to own the page: the gateway also
 * serves the dashboard, but only the built bundle, which is what `npm start`
 * is for.
 *
 * Plain Node rather than `concurrently` or `npm-run-all`: this is thirty lines,
 * and the two things a combined runner has to get right — prefixed output, and
 * killing BOTH children when either one dies or you press Ctrl-C — are exactly
 * the two things worth being able to read.
 */

import { spawn } from "node:child_process";
import process from "node:process";

const RESET = "\u001b[0m";

const targets = [
  {
    name: "gateway",
    colour: "\u001b[36m",
    command: process.execPath,
    // --env-file-if-exists: loads .env when present, no error when absent, no
    // dotenv dependency. Node does this natively as of 22.
    args: [
      "--watch",
      "--watch-preserve-output",
      "--env-file-if-exists=.env",
      "server/bin/fest.ts",
      "serve",
    ],
  },
  {
    name: "web",
    colour: "\u001b[35m",
    command: process.execPath,
    args: ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1"],
  },
];

const children = [];
let shuttingDown = false;

/** Prefix every line so two interleaved streams stay readable. */
function pipe(stream, name, colour, out) {
  let carry = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (carry + chunk).split("\n");
    // The final element is a partial line; hold it until its newline arrives,
    // or a prefix lands mid-word every time a child flushes on a chunk edge.
    carry = lines.pop() ?? "";
    for (const line of lines) out.write(`${colour}${name.padEnd(7)}${RESET} │ ${line}\n`);
  });
  stream.on("end", () => {
    if (carry !== "") out.write(`${colour}${name.padEnd(7)}${RESET} │ ${carry}\n`);
  });
}

function shutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`\ndev: ${reason}; stopping both\n`);
  for (const child of children) child.kill("SIGTERM");
  // Nobody waits forever for a wedged child.
  setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
    process.exit(code);
  }, 3000).unref();
  let pending = children.filter((c) => c.exitCode === null).length;
  if (pending === 0) process.exit(code);
  for (const child of children) {
    child.on("exit", () => {
      pending -= 1;
      if (pending <= 0) process.exit(code);
    });
  }
}

for (const target of targets) {
  const child = spawn(target.command, target.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  pipe(child.stdout, target.name, target.colour, process.stdout);
  pipe(child.stderr, target.name, target.colour, process.stderr);
  child.on("exit", (code, signal) => {
    // One half of a dev stack is not a dev stack: if either dies, take the
    // other down rather than leave a half-working setup that looks fine.
    if (!shuttingDown) {
      shutdown(`${target.name} exited (${signal ?? code})`, code === 0 ? 0 : 1);
    }
  });
  child.on("error", (err) => shutdown(`${target.name} failed to start: ${err.message}`, 1));
  children.push(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

process.stdout.write(
  [
    "",
    "  fest dev",
    "  ─────────────────────────────────────────────────────────",
    `  dashboard   http://127.0.0.1:5173        <- open this (not localhost:5173 — see OAuth note above)`,
    `  gateway     http://127.0.0.1:${process.env.FEST_PORT ?? 8787}`,
    "",
    `  point Claude Code at the GATEWAY, not the dashboard:`,
    `    ANTHROPIC_BASE_URL=http://127.0.0.1:${process.env.FEST_PORT ?? 8787}/t/<your-token>`,
    `  and unset ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN — either one`,
    `  silently downgrades you off your subscription.`,
    "",
  ].join("\n"),
);
