"use client";

// Light haptic feedback on supported devices (Android/Chrome; iOS Safari does
// not expose the Vibration API, so it silently no-ops there). Paired with the
// CSS :active press effect so every device gets *some* click feedback.

type Strength = "light" | "medium" | "success" | "warning";

const PATTERNS: Record<Strength, number | number[]> = {
  light: 10,
  medium: 20,
  success: [12, 40, 12],
  warning: [24, 40, 24],
};

export function haptic(strength: Strength = "light"): void {
  if (typeof navigator === "undefined") return;
  // Respect the user's Customize setting.
  try {
    const raw = localStorage.getItem("famlist.settings");
    if (raw && JSON.parse(raw).haptics === false) return;
  } catch { /* default to on */ }
  try {
    navigator.vibrate?.(PATTERNS[strength]);
  } catch {
    /* unsupported — ignore */
  }
}

// Convenience for taps on controls.
export const tap = () => haptic("light");
export const tapSuccess = () => haptic("success");
export const tapWarn = () => haptic("warning");
