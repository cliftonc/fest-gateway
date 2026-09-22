/**
 * Ease a displayed number toward its target instead of snapping.
 *
 * On a live counter the jump itself carries information — a figure that slides
 * from 1.2k to 4.8k reads as "that grew a lot", where a replaced number reads
 * as a re-render. The easing is exponential rather than fixed-duration so
 * rapid successive updates stay smooth instead of queueing.
 *
 * Honours `prefers-reduced-motion` by snapping, because a number that will not
 * hold still is genuinely hard to read for some people.
 */

import { useEffect, useRef, useState } from "react";

const EPSILON = 0.5;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useAnimatedNumber(target: number, durationMs = 450): number {
  const [display, setDisplay] = useState(target);
  const frame = useRef(0);
  const from = useRef(target);
  const start = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      setDisplay(target);
      return;
    }

    from.current = display;
    start.current = performance.now();

    const tick = (t: number): void => {
      const p = Math.min(1, (t - start.current) / durationMs);
      // easeOutCubic: fast to respond, settles without overshoot.
      const eased = 1 - Math.pow(1 - p, 3);
      const next = from.current + (target - from.current) * eased;
      setDisplay(Math.abs(target - next) < EPSILON ? target : next);
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
    // `display` is deliberately not a dependency: reading it as the start point
    // is the point, but depending on it would restart the tween every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, durationMs]);

  return display;
}
