// §Global: "Colorful color theme option. Uses colors to differentiate
// between things." Opt-in. When on, any repeating label (a product
// category, an expense type, a salesman) gets its own stable colour, so the
// same thing is the same colour everywhere it appears — the point is
// telling items apart at a glance, not decorating the chrome.
//
// Stable by label hash rather than by list position, so a category doesn't
// change colour when the sort order or the set of rows changes.

export const CATEGORY_PALETTE = [
  "#2fc494", // green
  "#3b82f6", // blue
  "#f0653e", // coral
  "#8b5cf6", // purple
  "#e0a12a", // amber
  "#14b8a6", // teal
  "#ec4899", // pink
  "#0ea5e9", // sky
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
  "#06b6d4", // cyan
];

function hash(label: string): number {
  let h = 0;
  for (let i = 0; i < label.length; i++) {
    h = (h << 5) - h + label.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function colorForLabel(label: string): string {
  return CATEGORY_PALETTE[hash(label.trim().toLowerCase()) % CATEGORY_PALETTE.length];
}

// Same colour at a low alpha, for row/bar fills that sit behind text.
export function tintForLabel(label: string, alpha = 0.15): string {
  const hex = colorForLabel(label).replace("#", "");
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
