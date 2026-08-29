"use client";

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { listContainer, listItem, usePrefersReducedMotion } from "@/lib/motion";

/**
 * Rows rise in sequence rather than all at once. The effect is deliberately
 * subtle — ~35ms apart and 10px of travel — because the point is to make a
 * list feel like it settled into place, not to put on a show.
 *
 * Only worth wrapping the first screenful: past ~20 rows the tail of the
 * stagger arrives late enough to read as lag, so `max` caps how many items
 * animate and the rest appear immediately.
 */
export function StaggerList({
  children,
  className = "",
  max = 14,
}: {
  children: ReactNode[];
  className?: string;
  max?: number;
}) {
  const reduced = usePrefersReducedMotion();
  if (reduced) return <div className={className}>{children}</div>;

  return (
    <motion.div className={className} variants={listContainer} initial="hidden" animate="visible">
      {children.map((child, i) =>
        i < max ? (
          <motion.div key={i} variants={listItem}>
            {child}
          </motion.div>
        ) : (
          <div key={i}>{child}</div>
        )
      )}
    </motion.div>
  );
}
