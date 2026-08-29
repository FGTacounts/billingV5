"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/motion";

/**
 * Counts a figure into place instead of snapping to it — the way Stocks and
 * Fitness settle their numbers.
 *
 * Deliberately restrained: ~550ms, eased out hard so most of the distance is
 * covered in the first third, and it only animates when the value actually
 * changes. A headline figure someone is trying to read should arrive fast
 * and then hold still.
 *
 * `format` does the currency/percent formatting so the animation never has
 * to understand the notation. Reduced-motion viewers get the final value
 * with no interpolation at all.
 */
export default function AnimatedNumber({
  value,
  format,
  durationMs = 550,
  className = "",
}: {
  value: number;
  format: (n: number) => string;
  durationMs?: number;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduced) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }
    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      // easeOutQuint — matches the EASE_OUT curve used elsewhere.
      const eased = 1 - Math.pow(1 - t, 5);
      setDisplay(from + delta * eased);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Whatever we were mid-way through becomes the new starting point, so
      // an interrupted count never jumps backwards on the next change.
      fromRef.current = display;
    };
    // `display` is intentionally excluded — including it would restart the
    // animation on every frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, durationMs, reduced]);

  // tabular-nums keeps the digits from jittering horizontally as they change.
  return <span className={`tabular-nums ${className}`}>{format(display)}</span>;
}
