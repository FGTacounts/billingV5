"use client";

import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { springEnter, springExit, durations, EASE_OUT, usePrefersReducedMotion, respectMotion } from "@/lib/motion";
import { createPortal } from "react-dom";

export default function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  headerExtra,
  titlePrefix,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  headerExtra?: React.ReactNode;
  // Rendered immediately left of the title — e.g. a leaderboard rank badge.
  titlePrefix?: React.ReactNode;
}) {
  useEffect(() => {
    if (open) document.body.classList.add("overflow-hidden");
    else document.body.classList.remove("overflow-hidden");
    return () => document.body.classList.remove("overflow-hidden");
  }, [open]);

  // Escape closes the sheet, the same as clicking the scrim or the X. Every
  // dialog on the web behaves this way, and someone who has half-filled a
  // form and changed their mind reaches for it before the mouse.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Portal to <body>. Without this a Sheet opened from inside a Framer
  // Motion `layout` widget (the dashboard's ArrangeGrid) is trapped in that
  // widget's transform-induced stacking context, so a second Sheet opened on
  // top of it — e.g. the salesman drill-down over the leaderboard — renders
  // but stays painted underneath no matter what z-index it carries.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const reduced = usePrefersReducedMotion();

  const content = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-stretch sm:items-center sm:justify-center"
          // The scrim deepens and the blur builds as the sheet arrives,
          // rather than snapping on — the backdrop should feel like it is
          // being pushed back by the sheet, not switched on behind it.
          initial={{ opacity: 0, backdropFilter: "blur(0px)", backgroundColor: "rgba(0,0,0,0)" }}
          animate={{ opacity: 1, backdropFilter: "blur(8px)", backgroundColor: "rgba(0,0,0,0.32)" }}
          exit={{ opacity: 0, backdropFilter: "blur(0px)", backgroundColor: "rgba(0,0,0,0)" }}
          transition={respectMotion({ duration: durations.fast, ease: EASE_OUT }, reduced)}
          onClick={onClose}
        >
          <motion.div
            className="glass shadow-overlay w-full sm:max-w-4xl sm:max-h-[92vh] h-[94dvh] sm:h-auto flex flex-col rounded-t-sheet sm:rounded-sheet overflow-hidden"
            // Enters with a touch of overshoot; leaves without any. A sheet
            // that bounces on dismissal reads as hesitant.
            initial={{ y: 28, opacity: 0, scale: 0.985 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 16, opacity: 0, scale: 0.99, transition: respectMotion(springExit, reduced) }}
            transition={respectMotion(springEnter, reduced)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-hairline shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                {titlePrefix}
                <span className="text-headline font-semibold truncate">{title}</span>
              </div>
              <div className="flex items-center gap-3">
                {headerExtra}
                <button
                  onClick={onClose}
                  className="w-8 h-8 grid place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <X size={17} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && (
              <div className="flex gap-2 justify-end px-5 py-3.5 border-t border-hairline shrink-0">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (!mounted) return null;
  return createPortal(content, document.body);
}
