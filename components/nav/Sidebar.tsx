"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { motion } from "framer-motion";
import { springLayout, usePrefersReducedMotion, respectMotion } from "@/lib/motion";
import type { NavItem } from "@/lib/nav";
import { NAV_ICONS } from "./icons";
import { useBrandLogo } from "@/lib/hooks/useBrandLogo";
import { useNavShortcuts } from "@/lib/hooks/useNavShortcuts";

const HOVER_EXPAND_DELAY_MS = 3000;
const STORAGE_KEY = "fgt-sidebar-collapsed";

export default function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  // Opt-in "g then <key>" navigation shortcuts (§Global). Lives here because
  // the sidebar already receives this user's role-filtered nav list, so a
  // shortcut can never jump to a page they can't open.
  useNavShortcuts(items);
  // Pinned state (persisted) — the user's own choice via the toggle button.
  // Defaults to collapsed per spec; hydrated from localStorage after mount
  // so server/client markup matches on first paint.
  const [collapsed, setCollapsed] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  // Transient hover-expand overlay — only active while collapsed.
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { url: logoUrl } = useBrandLogo();
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) setCollapsed(stored === "1");
    setHydrated(true);
  }, []);

  function togglePinned() {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      return next;
    });
    setHoverExpanded(false);
  }

  function onMouseEnter() {
    if (!collapsed) return;
    hoverTimer.current = setTimeout(() => setHoverExpanded(true), HOVER_EXPAND_DELAY_MS);
  }

  function onMouseLeave() {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setHoverExpanded(false);
  }

  const expanded = !collapsed || hoverExpanded;

  return (
    <nav
      className={`hidden md:flex flex-col shrink-0 border-r border-hairline py-3 gap-1 transition-[width] duration-200 ease-out overflow-hidden ${
        expanded ? "w-56 px-3" : "w-[68px] px-2"
      } ${!hydrated ? "invisible" : ""}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center justify-between mb-2 px-1 h-9">
        {expanded && (
          // eslint-disable-next-line @next/next/no-img-element -- small brand asset, not worth next/image here
          <img src={logoUrl} alt="FGT" className="h-7 w-auto shrink-0" />
        )}
        <button
          onClick={togglePinned}
          className="w-8 h-8 grid place-items-center rounded-card text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-primary transition-colors shrink-0"
          aria-label={collapsed ? "Pin sidebar open" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      {items
        .filter((item) => item.icon !== "settings")
        .map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = NAV_ICONS[item.icon];
          return (
            <Link
              key={item.href}
              href={item.href}
              title={expanded ? undefined : item.label}
              className={`relative flex items-center gap-3 px-3 py-2.5 rounded-card text-subhead font-medium transition-colors whitespace-nowrap ${
                active
                  ? "text-accent"
                  : "text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-primary"
              }`}
            >
              {/* One pill shared across every item — Framer matches them by
                  layoutId, so selecting a different page slides the
                  highlight there instead of cross-fading two rectangles. */}
              {active && (
                <motion.span
                  layoutId="sidebar-active-pill"
                  transition={respectMotion(springLayout, reduced)}
                  className="absolute inset-0 rounded-card bg-accent/15"
                />
              )}
              <Icon size={19} strokeWidth={active ? 2.4 : 2} className="shrink-0 relative z-10" />
              {expanded && <span className="relative z-10">{item.label}</span>}
            </Link>
          );
        })}

      {/* Settings pinned at the very bottom (§General) regardless of how
          long the main list above is — a spacer, not just last-in-array. */}
      <div className="mt-auto pt-2 border-t border-hairline">
        {items
          .filter((item) => item.icon === "settings")
          .map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = NAV_ICONS[item.icon];
            return (
              <Link
                key={item.href}
                href={item.href}
                title={expanded ? undefined : item.label}
                className={`relative flex items-center gap-3 px-3 py-2.5 rounded-card text-subhead font-medium transition-colors whitespace-nowrap ${
                  active
                    ? "bg-accent/15 text-accent"
                    : "text-secondary hover:bg-black/5 dark:hover:bg-white/5 hover:text-primary"
                }`}
              >
                <Icon size={19} strokeWidth={active ? 2.4 : 2} className="shrink-0" />
                {expanded && item.label}
              </Link>
            );
          })}
      </div>
    </nav>
  );
}
