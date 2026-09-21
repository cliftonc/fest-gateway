/**
 * Hot-reload the routing table when its file changes.
 *
 * Routing config is the thing an operator iterates on — add a route, try it,
 * adjust the model id — and a restart per edit is both slow and, under
 * `node --watch`, invisible: the watcher only tracks imported `.ts` files, so
 * editing `routes.json` appeared to do nothing at all. That is a worse failure
 * than a slow one, because it looks like the config is wrong.
 *
 * The rule that makes this safe: **a table that fails to validate is REJECTED,
 * and the previous one stays in force.** Never degrade to "no routing" on a bad
 * edit — that would silently send substituted traffic back onto developers'
 * subscriptions, which is the exact failure the whole project is designed
 * against. A typo should change nothing, loudly.
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { parseRouteTable } from "./table.ts";
import type { RouteTable } from "./table.ts";
import { log } from "../log.ts";

/** Editors write-then-rename, so one save can emit several events. */
const SETTLE_MS = 150;

/**
 * Backstop poll interval.
 *
 * `fs.watch` is not reliable everywhere: it drops events fired immediately
 * after the watcher attaches, and on several container and network mounts it
 * never fires at all. Since the whole point is that an edit takes effect
 * without a restart, "usually notices" is not good enough — a cheap `stat`
 * every few seconds turns a missed event into a few seconds of delay rather
 * than silence.
 */
const POLL_MS = 2_000;

export interface RouteWatcher {
  current(): RouteTable;
  stop(): void;
}

export function watchRoutes(path: string, initial: RouteTable): RouteWatcher {
  let table = initial;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  let lastMtimeMs: number | null = null;

  const reload = async (): Promise<void> => {
    try {
      const next = parseRouteTable(await readFile(path, "utf8"));
      if (next.version === table.version) return;
      table = next;
      log.info("routing table reloaded", {
        path,
        version: next.version,
        routes: next.routes.length,
        upstreams: [...next.upstreams.keys()],
      });
    } catch (err) {
      // Loudly, and without changing anything.
      log.error("routing table reload REJECTED; keeping the previous table", {
        path,
        version: table.version,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Backstop: notice a change even when no watch event arrives.
  const poll = setInterval(() => {
    void stat(path)
      .then((st) => {
        if (lastMtimeMs !== null && st.mtimeMs === lastMtimeMs) return;
        lastMtimeMs = st.mtimeMs;
        return reload();
      })
      .catch(() => {
        // The file may be mid-rename by an editor; the next tick will catch it.
      });
  }, POLL_MS);
  poll.unref();

  try {
    watcher = watch(path, () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => void reload(), SETTLE_MS);
    });
    // Never hold the process open just to watch config.
    watcher.unref();
  } catch (err) {
    // Not fatal: the gateway runs fine, it just will not notice edits. Some
    // filesystems (and some container mounts) do not support watching.
    log.warn("could not watch routing table; edits need a restart", {
      path,
      error: String(err).slice(0, 120),
    });
  }

  return {
    current: () => table,
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      clearInterval(poll);
      watcher?.close();
    },
  };
}
