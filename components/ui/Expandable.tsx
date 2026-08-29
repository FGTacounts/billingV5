"use client";

import { useState, type ReactNode } from "react";
import Sheet from "@/components/ui/Sheet";

// Shared "enlargeable, click-to-expand" affordance for dashboard widgets
// and data points (§General). Wrap any card/tile's content in this — it
// gets the hover-lift/press treatment for free (via the .enlargeable CSS
// class) and opens a full-size Sheet on click. Pass `expandedContent` when
// the enlarged view should show more than the compact tile (e.g. a full
// table instead of a truncated preview); otherwise the same children are
// just re-rendered larger inside the sheet.
export default function Expandable({
  title,
  children,
  expandedContent,
  className = "",
}: {
  title: string;
  children: ReactNode;
  expandedContent?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className={`enlargeable ${className}`}
        onClick={() => setOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setOpen(true)}
      >
        {children}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        <div className="text-headline">{expandedContent ?? children}</div>
      </Sheet>
    </>
  );
}
