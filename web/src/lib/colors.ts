/**
 * Resolved status-tone colours, for the things that cannot use a CSS class.
 *
 * TanStack Charts takes colour *values* — they go into a chart definition and
 * are painted into SVG, so `var(--status-ok)` in a class name never reaches
 * them. Reading the computed value keeps `styles.css` the single source of
 * truth instead of a second hardcoded palette drifting beside it.
 *
 * This must re-read on theme change: a module-level constant would freeze to
 * whichever theme was active at import time and never update again.
 */

import { useMemo } from "react";
import { useTheme } from "./theme.tsx";

export interface StatusColors {
  readonly ok: string;
  readonly warn: string;
  readonly bad: string;
  readonly info: string;
  readonly sub: string;
  readonly muted: string;
}

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function useStatusColors(): StatusColors {
  const { theme } = useTheme();

  // `theme` is not read in the body — it is the invalidation signal. The values
  // come from the cascade, which has already been updated by the time this runs.
  return useMemo(
    () => ({
      ok: cssVar("--status-ok"),
      warn: cssVar("--status-warn"),
      bad: cssVar("--status-bad"),
      info: cssVar("--status-info"),
      sub: cssVar("--status-sub"),
      muted: cssVar("--muted-foreground"),
    }),
    [theme],
  );
}
