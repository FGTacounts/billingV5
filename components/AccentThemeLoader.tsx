"use client";

import { useEffect } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { findAccentTheme, applyAccentTheme } from "@/lib/accentThemes";

const CACHE_KEY = "fgt-accent-theme";

// Applies the Manager's chosen app-wide accent color for every signed-in
// user (§Next Updates: "allow the manager to change the color theme for all
// users in Settings"). Mounted once in the root layout — the inline script
// there applies a cached value pre-paint to avoid a flash; this reconciles
// with the live app_settings row once the client hydrates.
export default function AccentThemeLoader() {
  useEffect(() => {
    supabaseBrowser()
      .from("app_settings")
      .select("accent_theme")
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        // Missing column (pre-migration) or no row yet — stay on default.
        if (error || !data) return;
        const theme = findAccentTheme(data.accent_theme);
        applyAccentTheme(theme);
        try {
          localStorage.setItem(CACHE_KEY, theme.key);
        } catch {}
      });
  }, []);

  return null;
}
