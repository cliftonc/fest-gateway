/**
 * The Live screen's measure, remembered.
 *
 * A hook and not a provider, unlike `theme.tsx`. The theme needs a context
 * because it writes a class on <html> and Radix portals mount outside the React
 * tree — a global concern with no single owner. The measure has exactly one
 * owner, `LivePage`, and every consumer is one of its direct children, so a
 * provider would be scope inflation. Promote it if Stats ever wants the same
 * switch.
 *
 * No pre-paint script either: there is nothing to apply to the document, and a
 * wrong first frame here is a button style rather than a whole-page flash.
 */

import { useCallback, useState } from "react";
import { MEASURE_STORAGE_KEY, type Measure } from "../lib/measure.ts";

function stored(): Measure | null {
  try {
    const raw = window.localStorage.getItem(MEASURE_STORAGE_KEY);
    return raw === "tokens" || raw === "billed" || raw === "value" ? raw : null;
  } catch {
    // Private browsing, or storage disabled by policy. Not a reason to fail to
    // render a dashboard.
    return null;
  }
}

export function useMeasure(): { measure: Measure; setMeasure: (next: Measure) => void } {
  const [measure, setMeasureState] = useState<Measure>(() => stored() ?? "tokens");

  const setMeasure = useCallback((next: Measure) => {
    setMeasureState(next);
    try {
      window.localStorage.setItem(MEASURE_STORAGE_KEY, next);
    } catch {
      // As in theme.tsx: a choice that does not survive a reload still beats a
      // crash.
    }
  }, []);

  return { measure, setMeasure };
}
