// Manager-configurable app-wide accent palette (§Next Updates: "don't copy
// the [mockup] color theme, allow the manager to change the color theme for
// all users in Settings"). Deliberately just the accent/accent-strong pair,
// not a full re-theme — the rest of the design system (surfaces, text,
// status colors) stays fixed per §General ("colorful data, not a colorful
// UI/theme").
export interface AccentTheme {
  key: string;
  label: string;
  accent: string;
  accentStrong: string;
}

export const ACCENT_THEMES: AccentTheme[] = [
  { key: "green", label: "Green", accent: "#2fc494", accentStrong: "#23a37c" },
  { key: "blue", label: "Blue", accent: "#3b82f6", accentStrong: "#2563eb" },
  { key: "purple", label: "Purple", accent: "#8b5cf6", accentStrong: "#7c3aed" },
  { key: "coral", label: "Coral", accent: "#f0653e", accentStrong: "#d94f2b" },
  { key: "amber", label: "Amber", accent: "#e0a12a", accentStrong: "#c78a1a" },
  { key: "teal", label: "Teal", accent: "#14b8a6", accentStrong: "#0d9488" },
];

export const DEFAULT_ACCENT_THEME = ACCENT_THEMES[0];

export function findAccentTheme(key: string | null | undefined): AccentTheme {
  return ACCENT_THEMES.find((t) => t.key === key) ?? DEFAULT_ACCENT_THEME;
}

function hexToRgbChannels(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function applyAccentTheme(theme: AccentTheme) {
  const root = document.documentElement;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-strong", theme.accentStrong);
  // Tailwind's accent utilities resolve through the RGB-channel variable so
  // opacity modifiers (bg-accent/12) work — it has to move with the hex.
  root.style.setProperty("--accent-rgb", hexToRgbChannels(theme.accent));
}
