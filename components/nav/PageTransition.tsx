"use client";

import { usePathname } from "next/navigation";

// Re-runs the rise-in animation whenever the route changes, by keying the
// wrapper on the pathname so React remounts it. Cheap compared to wrapping
// the tree in AnimatePresence: this is a server-rendered layout, and the
// exit half of a page transition would mean holding the old page's DOM
// around, which fights streaming.
//
// The animation is pure CSS (.rise-in), so prefers-reduced-motion already
// neutralises it via the global rule — no JS check needed here.
export default function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="rise-in">
      {children}
    </div>
  );
}
