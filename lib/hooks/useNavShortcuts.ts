"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { usePreferences } from "@/lib/hooks/usePreferences";
import type { NavItem } from "@/lib/nav";

// §Global: "add shortcuts for app navigation — disabled by default, but
// allow setting custom shortcuts or choosing default shortcuts, in
// Settings." Off unless the user turns them on; the default scheme is
// g-then-<key> (a "go to" chord, so it can't collide with typing), and a
// user can remap any single key in Settings.
export const DEFAULT_NAV_KEYS: Record<string, string> = {
  "/dashboard": "d",
  "/orders": "o",
  "/customers": "c",
  "/products": "p",
  "/sales": "s",
  "/payments": "y",
  "/invoices": "i",
  "/reports": "r",
  "/expense": "e",
  "/picking": "k",
  "/planning": "l",
  "/settings": ",",
};

const CHORD_TIMEOUT_MS = 1200;

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    node.isContentEditable === true
  );
}

export function useNavShortcuts(navItems: NavItem[]) {
  const router = useRouter();
  const { preferences } = usePreferences();
  const enabled = preferences.navShortcutsEnabled === true;
  const custom = preferences.navShortcutKeys ?? {};

  useEffect(() => {
    if (!enabled) return;

    // Only bind routes this user can actually reach, so a shortcut never
    // navigates someone into a page their role doesn't have.
    const keyToHref = new Map<string, string>();
    for (const item of navItems) {
      const key = (custom[item.href] ?? DEFAULT_NAV_KEYS[item.href] ?? "").toLowerCase();
      if (key) keyToHref.set(key, item.href);
    }

    let armed = false;
    let armedAt = 0;

    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;

      const key = e.key.toLowerCase();
      if (armed && Date.now() - armedAt < CHORD_TIMEOUT_MS) {
        armed = false;
        const href = keyToHref.get(key);
        if (href) {
          e.preventDefault();
          router.push(href);
        }
        return;
      }
      armed = key === "g";
      armedAt = Date.now();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, custom, navItems, router]);
}
