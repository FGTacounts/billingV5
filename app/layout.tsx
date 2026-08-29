import "./globals.css";
import type { Metadata, Viewport } from "next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { Analytics } from "@vercel/analytics/next";
import QueryProvider from "@/lib/query-provider";
import AccentThemeLoader from "@/components/AccentThemeLoader";

export const metadata: Metadata = {
  title: "Famlist Billing",
  description: "Famlist Billing System",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

const THEME_INIT = `
try {
  var stored = localStorage.getItem("fgt-theme");
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  }
  var accents = {
    green: ["#2fc494", "#23a37c"],
    blue: ["#3b82f6", "#2563eb"],
    purple: ["#8b5cf6", "#7c3aed"],
    coral: ["#f0653e", "#d94f2b"],
    amber: ["#e0a12a", "#c78a1a"],
    teal: ["#14b8a6", "#0d9488"],
  };
  var accentKey = localStorage.getItem("fgt-accent-theme");
  var accent = accents[accentKey];
  if (accent) {
    document.documentElement.style.setProperty("--accent", accent[0]);
    document.documentElement.style.setProperty("--accent-strong", accent[1]);
    var n = parseInt(accent[0].slice(1), 16);
    document.documentElement.style.setProperty(
      "--accent-rgb",
      ((n >> 16) & 255) + " " + ((n >> 8) & 255) + " " + (n & 255)
    );
  }
} catch (e) {}
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="font-sans">
        <AccentThemeLoader />
        <QueryProvider>{children}</QueryProvider>
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
