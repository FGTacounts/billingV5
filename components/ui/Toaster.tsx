"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { useToasts, dismiss, type ToastTone } from "@/lib/toast";
import { springEnter, springExit, usePrefersReducedMotion, respectMotion } from "@/lib/motion";

const TONE: Record<ToastTone, { icon: typeof Info; className: string }> = {
  success: { icon: CheckCircle2, className: "text-accent" },
  error: { icon: AlertCircle, className: "text-[--status-danger]" },
  info: { icon: Info, className: "text-[--status-info]" },
};

/**
 * Replaces the browser's toast.error() — which blocks the thread, ignores the
 * app's design entirely, and gives no sense of where the message came from.
 *
 * Sits above the phone tab bar so it never covers navigation, and stacks
 * newest-last so a burst of messages reads top to bottom.
 */
export default function Toaster() {
  const toasts = useToasts();
  const reduced = usePrefersReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return createPortal(
    <div className="fixed z-[60] left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+72px)] md:bottom-6 flex flex-col gap-2 w-[calc(100vw-32px)] max-w-[420px] pointer-events-none">
      <AnimatePresence initial={false}>
        {toasts.map((t) => {
          const { icon: Icon, className } = TONE[t.tone];
          return (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98, transition: respectMotion(springExit, reduced) }}
              transition={respectMotion(springEnter, reduced)}
              className="pointer-events-auto glass shadow-overlay rounded-card px-4 py-3 flex items-start gap-3"
              role="status"
              aria-live="polite"
            >
              <Icon size={18} className={`${className} shrink-0 mt-0.5`} />
              <span className="text-subhead flex-1 min-w-0">{t.message}</span>
              <button
                onClick={() => dismiss(t.id)}
                className="shrink-0 text-secondary hover:text-primary -mr-1"
                aria-label="Dismiss"
              >
                <X size={15} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>,
    document.body
  );
}
