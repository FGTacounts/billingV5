import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class", '[data-theme="dark"]'],
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Colors that get used with a Tailwind opacity modifier (bg-accent/12,
      // border-accent/50, …) must be declared as space-separated RGB
      // channels — an opacity modifier on a plain `var(--x)` hex compiles to
      // `rgb(#2fc494 / 0.12)`, which is invalid CSS and silently renders
      // fully transparent. That bug made ~30 tinted surfaces across the app
      // (tinted buttons, leaderboard rows, accent pills, hover borders)
      // disappear into the background, which is a large part of why
      // buttons read as plain text. The plain `--accent` variables are kept
      // alongside for direct use in CSS/inline styles.
      colors: {
        canvas: "var(--bg-canvas)",
        surface: "var(--bg-surface)",
        primary: "var(--text-primary)",
        secondary: "rgb(var(--text-secondary-rgb) / <alpha-value>)",
        accent: "rgb(var(--accent-rgb) / <alpha-value>)",
        "accent-strong": "var(--accent-strong)",
        warning: "rgb(var(--status-warning-rgb) / <alpha-value>)",
        danger: "rgb(var(--status-danger-rgb) / <alpha-value>)",
        info: "rgb(var(--status-info-rgb) / <alpha-value>)",
        hairline: "var(--hairline)",
      },
      // Tailwind's default opacity scale skips 8/12/18, so `bg-accent/12`
      // (the tinted-button tier), `hover:bg-accent/18` and `bg-danger/8`
      // were silently never generated — the elements rendered with no
      // background at all, which is why tinted buttons looked like plain
      // text. Registering the steps the design system actually uses.
      opacity: {
        8: "0.08",
        12: "0.12",
        18: "0.18",
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "SF Pro Text",
          "Inter",
          "system-ui",
          "sans-serif",
        ],
      },
      // Optical tracking, the way SF does it: large text tightens, small
      // text opens up slightly. Without this, a 34px heading set at default
      // tracking looks loose and unset next to Apple's own UI — it is the
      // difference most people read as "polished" without being able to
      // name it.
      fontSize: {
        "large-title": ["34px", { lineHeight: "40px", fontWeight: "700", letterSpacing: "-0.021em" }],
        title: ["22px", { lineHeight: "28px", fontWeight: "600", letterSpacing: "-0.017em" }],
        headline: ["17px", { lineHeight: "22px", fontWeight: "600", letterSpacing: "-0.011em" }],
        body: ["17px", { lineHeight: "22px", fontWeight: "400", letterSpacing: "-0.011em" }],
        subhead: ["15px", { lineHeight: "20px", fontWeight: "400", letterSpacing: "-0.006em" }],
        caption: ["13px", { lineHeight: "18px", fontWeight: "400", letterSpacing: "0" }],
      },
      // One radius everywhere — cards, sheets, buttons (§Next Updates: "all
      // the corners have the perfect and same corner radius... the button
      // radius should be the same, around 30").
      // Concentric radii. A block sitting inside a 30px card should not be
      // 8px — nested corners only look right when the inner radius is the
      // outer radius minus the gap between them, otherwise the inner corner
      // reads as sharp against the curve around it.
      borderRadius: {
        card: "30px",
        sheet: "30px",
        inner: "20px", // a block inside a card with ~8-10px of padding
        chip: "14px",  // pills, tags, small controls
        well: "10px",  // tightest — swatches, inline markers
      },
      spacing: {
        "8pt": "8px",
      },
      // A real elevation ladder rather than one catch-all shadow. Each step
      // pairs a tight contact shadow with a wider ambient one, which is what
      // stops a raised surface looking like it is floating in a vacuum.
      boxShadow: {
        hairline: "0 1px 2px rgba(0,0,0,0.04)",
        raised: "0 1px 2px rgba(0,0,0,0.05), 0 4px 12px rgba(0,0,0,0.05)",
        floating: "0 4px 14px rgba(0,0,0,0.10), 0 12px 32px rgba(0,0,0,0.08)",
        overlay: "0 8px 28px rgba(0,0,0,0.14), 0 28px 64px rgba(0,0,0,0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
