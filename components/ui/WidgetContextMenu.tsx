"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Minus, Square, Columns2, LayoutGrid, Check } from "lucide-react";
import type { WidgetSize } from "./WidgetArrange";
import { springEnter, durations, EASE_OUT, usePrefersReducedMotion, respectMotion } from "@/lib/motion";

const SIZES: { key: WidgetSize; label: string; icon: typeof Square }[] = [
  { key: "quarter", label: "Quarter", icon: Square },
  { key: "half", label: "Half", icon: Columns2 },
  { key: "full", label: "Full width", icon: LayoutGrid },
];

const LONG_PRESS_MS = 500;

/**
 * Right-click (or long-press on touch) a widget to resize or remove it —
 * the way you'd resize a widget on a Mac.
 *
 * The point is that it needs no mode. The previous flow put the whole page
 * into an edit state behind a panel, so nothing else on the dashboard could
 * be clicked while you were adjusting one widget. Here the menu is attached
 * to the widget you actually clicked, everything else stays live, and it
 * closes on the next click anywhere.
 */
export function WidgetContextMenu({
  children,
  size,
  label,
  onChangeSize,
  onRemove,
  className = "",
}: {
  children: ReactNode;
  size: WidgetSize;
  label: string;
  onChangeSize: (s: WidgetSize) => void;
  onRemove: () => void;
  className?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [mounted, setMounted] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => setMounted(true), []);

  // Close on any outside click, scroll, or Escape.
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [at]);

  function openAt(x: number, y: number) {
    // Keep the menu on screen when the widget is near an edge.
    const w = 190;
    const h = 210;
    setAt({
      x: Math.min(x, window.innerWidth - w - 12),
      y: Math.min(y, window.innerHeight - h - 12),
    });
  }

  function onContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    openAt(e.clientX, e.clientY);
  }

  // Touch has no right-click, so long-press opens the same menu.
  function onTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    pressTimer.current = setTimeout(() => openAt(t.clientX, t.clientY), LONG_PRESS_MS);
  }
  function cancelPress() {
    if (pressTimer.current) clearTimeout(pressTimer.current);
  }

  return (
    <>
      <div
        className={className}
        onContextMenu={onContextMenu}
        onTouchStart={onTouchStart}
        onTouchEnd={cancelPress}
        onTouchMove={cancelPress}
        onTouchCancel={cancelPress}
      >
        {children}
      </div>

      {mounted &&
        createPortal(
          <AnimatePresence>
            {at && (
              <motion.div
                role="menu"
                aria-label={`${label} options`}
                initial={{ opacity: 0, scale: 0.94, y: -4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: durations.instant, ease: EASE_OUT } }}
                transition={respectMotion(springEnter, reduced)}
                style={{ left: at.x, top: at.y }}
                className="fixed z-[70] w-[190px] rounded-card surface-panel shadow-overlay overflow-hidden origin-top-left"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-3.5 py-2.5 border-b border-hairline">
                  <div className="text-caption text-secondary">Widget</div>
                  <div className="text-subhead font-semibold truncate">{label}</div>
                </div>
                {SIZES.map(({ key, label: l, icon: Icon }) => (
                  <button
                    key={key}
                    role="menuitemradio"
                    aria-checked={size === key}
                    onClick={() => {
                      onChangeSize(key);
                      setAt(null);
                    }}
                    className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-subhead hover:bg-black/[0.03] dark:hover:bg-white/[0.05] hover:!opacity-100"
                  >
                    <Icon size={15} className="text-secondary shrink-0" />
                    <span className="flex-1 text-left">{l}</span>
                    {size === key && <Check size={15} className="text-accent shrink-0" />}
                  </button>
                ))}
                <button
                  role="menuitem"
                  onClick={() => {
                    onRemove();
                    setAt(null);
                  }}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-subhead text-[--status-danger] border-t border-hairline hover:bg-danger/8 hover:!opacity-100"
                >
                  <Minus size={15} className="shrink-0" />
                  Remove widget
                </button>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  );
}
