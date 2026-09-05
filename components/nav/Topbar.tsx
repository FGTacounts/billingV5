"use client";

import { useState } from "react";
import Link from "next/link";
import { Settings, Inbox, ArrowRight, LogOut, ChevronDown } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { springEnter, durations, EASE_OUT, usePrefersReducedMotion, respectMotion } from "@/lib/motion";
import NotificationsBell from "@/components/NotificationsBell";
import type { AppUser } from "@/lib/types/db";

const ROLE_LABEL: Record<AppUser["role"], string> = {
  salesman: "Salesman",
  manager: "Manager",
  warehouse: "Warehouse",
  admin: "Admin",
};

// Initials rather than a fixed letter — a signed-in person should see
// themselves in the corner, not the company monogram.
function initialsOf(name: string, fallback: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Topbar({ user }: { user: AppUser }) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const reduced = usePrefersReducedMotion();

  async function signOut() {
    setSigningOut(true);
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <header className="glass sticky top-0 z-30 flex items-center justify-between px-4 md:px-6 py-3.5 border-b border-hairline border-x-0 border-t-0 rounded-none">
      {/* Your own name is the natural place to look for Settings and Sign
          out, so it is a menu rather than decoration. */}
      <div className="relative">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center gap-3 rounded-card pr-2 pl-1 py-1 -ml-1 hover:bg-black/5 dark:hover:bg-white/10 transition-colors hover:!opacity-100"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="w-9 h-9 rounded-full bg-accent text-white font-bold grid place-items-center text-sm shrink-0">
            {initialsOf(user.full_name, user.username)}
          </span>
          <span className="text-left min-w-0">
            <span className="block text-headline font-semibold leading-none truncate">
              {user.full_name}
            </span>
            <span className="block text-caption text-secondary mt-0.5">
              {ROLE_LABEL[user.role]}
            </span>
          </span>
          <ChevronDown
            size={15}
            className={`text-secondary shrink-0 transition-transform ${menuOpen ? "rotate-180" : ""}`}
          />
        </button>

        <AnimatePresence>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <motion.div
                role="menu"
                initial={{ opacity: 0, y: -6, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.99, transition: { duration: durations.instant, ease: EASE_OUT } }}
                transition={respectMotion(springEnter, reduced)}
                className="absolute left-0 top-full mt-2 z-50 w-60 rounded-card surface-panel shadow-overlay overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-hairline">
                  <div className="text-subhead font-semibold truncate">{user.full_name}</div>
                  <div className="text-caption text-secondary truncate">
                    @{user.username} · {ROLE_LABEL[user.role]}
                  </div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="flex items-center gap-2.5 px-4 py-2.5 text-subhead hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
                >
                  <Settings size={16} className="text-secondary" /> Settings
                </Link>
                <button
                  onClick={signOut}
                  disabled={signingOut}
                  className="w-full flex items-center gap-2.5 px-4 py-2.5 text-subhead text-[--status-danger] hover:bg-danger/8 hover:!opacity-100 disabled:opacity-60"
                >
                  <LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            onClick={() => setInboxOpen((v) => !v)}
            className="w-9 h-9 grid place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            aria-label="Inbox"
          >
            <Inbox size={18} className="text-secondary" />
          </button>
          {inboxOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setInboxOpen(false)} />
              <div className="absolute right-0 top-11 z-50 w-80 max-h-96 overflow-y-auto rounded-card surface-panel shadow-floating">
                <Link
                  href="/inbox"
                  onClick={() => setInboxOpen(false)}
                  className="flex items-center justify-between px-4 py-3 border-b border-hairline font-semibold text-headline hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                >
                  Inbox
                  <ArrowRight size={16} className="text-secondary" />
                </Link>
                <div className="px-4 py-8 text-center text-secondary text-subhead">
                  Nothing here yet
                </div>
              </div>
            </>
          )}
        </div>
        {(user.role !== "manager" && user.role !== "admin") && (
          <Link
            href="/settings"
            className="w-9 h-9 grid place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
            aria-label="Settings"
          >
            <Settings size={18} className="text-secondary" />
          </Link>
        )}
        <NotificationsBell
          userId={user.id}
          isManager={user.role === "manager" || user.role === "admin"}
        />
      </div>
    </header>
  );
}
