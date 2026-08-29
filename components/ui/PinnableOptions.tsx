"use client";

import { useState } from "react";
import { ArrowUpDown, Pin, PinOff } from "lucide-react";

export interface PinnableOption {
  key: string;
  label: string;
}

// Shared "sort/adjust-view with pin" pattern (Customers §sort, Products
// §sort/adjust-view): a popover lists every option with a pin toggle next
// to it; selecting an option applies it, pinning one also drops a
// persistent chip button directly on the page. Nothing is pinned by
// default — the page starts with just this one trigger, exactly as
// specified ("I don't want those buttons as defaults, only if the user
// pins them").
export default function PinnableOptionsButton({
  options,
  active,
  pinned,
  onSelect,
  onTogglePin,
  label = "Sort",
}: {
  options: PinnableOption[];
  active: string;
  pinned: string[];
  onSelect: (key: string) => void;
  onTogglePin: (key: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-3.5 py-2.5 rounded-card border border-hairline text-secondary text-subhead font-medium"
      >
        <ArrowUpDown size={15} /> {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 mt-2 w-64 glass rounded-card shadow-floating z-50 p-1.5">
            {options.map((opt) => {
              const isPinned = pinned.includes(opt.key);
              const isActive = active === opt.key;
              return (
                <div
                  key={opt.key}
                  className={`flex items-center justify-between gap-2 px-2.5 py-2 rounded-inner text-subhead ${
                    isActive ? "bg-accent/10 text-accent" : "text-primary"
                  }`}
                >
                  <button className="flex-1 text-left" onClick={() => onSelect(opt.key)}>
                    {opt.label}
                  </button>
                  <button
                    onClick={() => onTogglePin(opt.key)}
                    className={isPinned ? "text-accent" : "text-secondary"}
                    aria-label={isPinned ? `Unpin ${opt.label}` : `Pin ${opt.label}`}
                    title={isPinned ? "Unpin" : "Pin as a button on the page"}
                  >
                    {isPinned ? <Pin size={14} fill="currentColor" /> : <PinOff size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
