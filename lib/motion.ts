"use client";

import { useEffect, useState } from "react";
import type { Transition, Variants } from "framer-motion";

// One motion vocabulary for the whole app. Before this, every component
// invented its own spring (320/28 here, 350/30 there, 300/30 elsewhere),
// so nothing moved quite like anything else — the single biggest reason a
// UI reads as "assembled" rather than "designed".
//
// The physics follow Apple's feel: things that ENTER overshoot very
// slightly, as though they have mass and settle; things that LEAVE do not
// overshoot at all, because a bouncing dismissal reads as indecision.

/** Sheets, modals, anything arriving from off-screen. Settles with a hair of overshoot. */
export const springEnter: Transition = { type: "spring", stiffness: 340, damping: 30, mass: 0.9 };

/** Dismissal. Critically damped — no bounce on the way out. */
export const springExit: Transition = { type: "spring", stiffness: 420, damping: 40, mass: 0.8 };

/** Layout reflow: reordering widgets, list items shifting. Slightly softer. */
export const springLayout: Transition = { type: "spring", stiffness: 300, damping: 32, mass: 1 };

/** Small, immediate feedback — a press, a toggle, a badge. Snappy. */
export const springSnappy: Transition = { type: "spring", stiffness: 520, damping: 34, mass: 0.6 };

/** Apple's standard ease for non-spring transitions (roughly easeOutQuint). */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;
/** Symmetric ease for things that move both ways. */
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

export const durations = {
  instant: 0.12,
  fast: 0.2,
  normal: 0.32,
  slow: 0.5,
} as const;

/** Page-level content arriving: a short rise plus fade. */
export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: durations.normal, ease: EASE_OUT } },
};

/**
 * Staggered list container. Children rise in sequence rather than all at
 * once, which is what makes a list feel populated rather than pasted.
 * The stagger is deliberately small — beyond ~40ms it starts to feel slow
 * on a long list rather than considered.
 */
export const listContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.035, delayChildren: 0.02 } },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: { opacity: 1, y: 0, transition: { duration: durations.normal, ease: EASE_OUT } },
};

/**
 * True when the viewer has asked for reduced motion. The global CSS rule in
 * globals.css already neuters CSS transitions, but Framer Motion animates
 * via inline style and JS, so it never sees that media query — components
 * driving springs need to check this themselves.
 *
 * Returns false on the server and on first paint so markup matches during
 * hydration, then corrects immediately after mount.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Collapses any transition to effectively-instant when motion is reduced. */
export function respectMotion(t: Transition, reduced: boolean): Transition {
  return reduced ? { duration: 0 } : t;
}
