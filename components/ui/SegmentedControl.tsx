"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { springLayout, usePrefersReducedMotion, respectMotion } from "@/lib/motion";

export interface Segment<T extends string> {
  key: T;
  label?: string;
  icon?: ReactNode;
  title?: string;
}

/**
 * An iOS-style segmented control: a recessed track with a rounded pill that
 * SLIDES to the selected segment.
 *
 * The older pattern — filling the selected segment edge-to-edge inside a
 * clipped container — leaves the fill's inner corners square where it meets
 * its neighbour, which is exactly the kind of hard edge that gives a UI
 * away. Insetting a fully rounded pill inside a padded track means every
 * visible corner is curved, and the movement carries the selection.
 */
export default function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  layoutId,
  className = "",
}: {
  segments: Segment<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Must be unique per control on the page, so two don't share one pill. */
  layoutId: string;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  return (
    <div
      className={`inline-flex items-center gap-0.5 p-1 rounded-card bg-secondary/8 border border-hairline ${className}`}
      role="tablist"
    >
      {segments.map((s) => {
        const active = s.key === value;
        return (
          <button
            key={s.key}
            role="tab"
            aria-selected={active}
            title={s.title ?? s.label}
            aria-label={s.title ?? s.label}
            onClick={() => onChange(s.key)}
            className={`relative px-3 py-1.5 rounded-chip text-caption font-semibold transition-colors hover:!opacity-100 ${
              active ? "text-white" : "text-secondary hover:text-primary"
            }`}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={respectMotion(springLayout, reduced)}
                className="absolute inset-0 rounded-chip bg-accent shadow-raised"
              />
            )}
            <span className="relative z-10 flex items-center gap-1.5">
              {s.icon}
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
