"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal, X } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { springEnter, springExit, springLayout, durations, EASE_OUT, usePrefersReducedMotion, respectMotion } from "@/lib/motion";
import { MAX_PRIMARY_NAV, type NavItem } from "@/lib/nav";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { NAV_ICONS } from "./icons";

function NavLink({ item, active, reduced }: { item: NavItem; active: boolean; reduced: boolean }) {
  const Icon = NAV_ICONS[item.icon];
  return (
    <Link
      href={item.href}
      className={`relative flex-1 min-w-[64px] flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium transition-colors ${
        active ? "text-accent" : "text-secondary"
      }`}
    >
      {/* The icon lifts and grows a touch when selected, the way a tab bar
          item does on iOS — motion carries the selection, not just colour. */}
      <motion.span
        animate={{ scale: active ? 1.08 : 1, y: active ? -1 : 0 }}
        transition={respectMotion(springLayout, reduced)}
        className="block"
      >
        <Icon size={20} strokeWidth={active ? 2.4 : 2} />
      </motion.span>
      {item.label}
    </Link>
  );
}

export default function MobileNav({
  primary,
  secondary,
}: {
  primary: NavItem[];
  secondary: NavItem[];
}) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const reduced = usePrefersReducedMotion();
  // The layout renders on the server and cannot read a per-user preference, so
  // the split it hands down is the default for the role. If this person has
  // chosen their own bar in Settings, re-split here from the same items —
  // never from anything wider, so a preference can't surface a destination the
  // role isn't allowed.
  const { preferences } = usePreferences();
  const chosen = preferences.primaryNav;
  const [barItems, moreItems] = useMemo(() => {
    const all = [...primary, ...secondary];
    if (!chosen || chosen.length === 0) return [primary, secondary];
    const picked = chosen
      .map((href) => all.find((i) => i.href === href))
      .filter((i): i is NavItem => Boolean(i))
      .slice(0, MAX_PRIMARY_NAV);
    if (picked.length === 0) return [primary, secondary];
    const pickedHrefs = new Set(picked.map((i) => i.href));
    return [picked, all.filter((i) => !pickedHrefs.has(i.href))];
  }, [primary, secondary, chosen]);

  const isActive = (item: NavItem) => pathname === item.href || pathname.startsWith(item.href + "/");
  const moreActive = moreItems.some(isActive);

  return (
    <>
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-hairline flex pb-[env(safe-area-inset-bottom)]">
        {barItems.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item)} reduced={reduced} />
        ))}
        {secondary.length > 0 && (
          <button
            onClick={() => setMoreOpen(true)}
            className={`flex-1 min-w-[64px] flex flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              moreActive ? "text-accent" : "text-secondary"
            }`}
          >
            <MoreHorizontal size={20} strokeWidth={moreActive ? 2.4 : 2} />
            Others
          </button>
        )}
      </nav>

      <AnimatePresence>
      {moreOpen && (
        <motion.div
          className="md:hidden fixed inset-0 z-40 flex items-end"
          onClick={() => setMoreOpen(false)}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={respectMotion({ duration: durations.fast, ease: EASE_OUT }, reduced)}
        >
          <div className="absolute inset-0 bg-black/30 backdrop-blur-[6px]" />
          <motion.div
            className="relative w-full bg-surface rounded-t-[20px] pb-[env(safe-area-inset-bottom)] shadow-overlay"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%", transition: respectMotion(springExit, reduced) }}
            transition={respectMotion(springEnter, reduced)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-hairline">
              <span className="text-headline font-semibold">Others</span>
              <button onClick={() => setMoreOpen(false)} aria-label="Close">
                <X size={20} className="text-secondary" />
              </button>
            </div>
            <div className="py-2">
              {moreItems.map((item) => {
                const Icon = NAV_ICONS[item.icon];
                const active = isActive(item);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    className={`flex items-center gap-3 px-5 py-3 text-subhead font-medium ${
                      active ? "text-accent" : "text-primary"
                    }`}
                  >
                    <Icon size={19} strokeWidth={active ? 2.4 : 2} />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>
    </>
  );
}
