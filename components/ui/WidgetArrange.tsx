"use client";

import { useState } from "react";
import { SlidersHorizontal, ChevronUp, ChevronDown, Eye, EyeOff } from "lucide-react";

// Shared "Arrange" widget-order popover (§Next Updates: "user-configurable
// Arrange section per tab") — built once for Dashboard, reused wherever a
// page has reorderable Full/Half/Quarter widgets (Sales, etc).

// Merges a stored order with the canonical widget-key list so newly-added
// widgets (or a stale/foreign key from an older build) never get silently
// dropped from the page.
export type WidgetSize = "full" | "half" | "quarter";

// Grid span for each size, on the shared 4-column widget grid.
// Width AND a standard height per size, so widgets in the same row line up.
// Without a shared height each card sized to its own content — which is why
// Average sale sat visibly shorter than Payments beside it. Half and full
// share the same height because they hold the same kind of chart; quarter is
// a stat tile and only needs to be tall enough to read.
export const SIZE_SPAN: Record<WidgetSize, string> = {
  full: "lg:col-span-4 min-h-[336px]",
  half: "lg:col-span-2 min-h-[336px]",
  quarter: "lg:col-span-1 min-h-[152px]",
};

export function resolveOrder<K extends string>(canonical: readonly K[], stored: string[] | undefined): K[] {
  const valid = (stored ?? []).filter((k): k is K => (canonical as readonly string[]).includes(k));
  const missing = canonical.filter((k) => !valid.includes(k));
  return [...valid, ...missing];
}

export function moveKey<K extends string>(order: K[], key: K, dir: -1 | 1): K[] {
  const i = order.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function WidgetAdjustPopover<K extends string>({
  order,
  labels,
  onChange,
  hidden,
  onToggleHidden,
  sizes,
  onChangeSize,
}: {
  order: K[];
  labels: Record<K, string>;
  onChange: (next: K[]) => void;
  // Optional show/hide, for pages with widgets that are off by default
  // (§Dashboard: "add a category/product-wise sales report widget, hidden
  // by default, optional"). Pages that don't pass these keep a
  // reorder-only popover.
  hidden?: K[];
  onToggleHidden?: (key: K) => void;
  // Optional per-widget size control (§Global: standardized Full / Half /
  // Quarter widget sizes). Pages that don't pass these keep their
  // hardcoded per-widget widths.
  sizes?: Partial<Record<K, WidgetSize>>;
  onChangeSize?: (key: K, size: WidgetSize) => void;
}) {
  const [open, setOpen] = useState(false);
  const hiddenSet = new Set(hidden ?? []);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2 rounded-full border border-hairline text-secondary hover:text-accent"
        aria-label="Arrange widgets"
        title="Arrange"
      >
        <SlidersHorizontal size={15} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 glass rounded-card shadow-floating z-20 p-2">
            <div className="text-caption text-secondary px-2 py-1.5">Widget order</div>
            {order.map((key, i) => (
              <div key={key} className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2 py-1.5 text-subhead">
                <span className={`truncate ${hiddenSet.has(key) ? "text-secondary line-through" : ""}`}>
                  {labels[key]}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  {onToggleHidden && (
                    <button
                      onClick={() => onToggleHidden(key)}
                      className="p-1 rounded-inner text-secondary hover:text-accent"
                      aria-label={`${hiddenSet.has(key) ? "Show" : "Hide"} ${labels[key]}`}
                      title={hiddenSet.has(key) ? "Show" : "Hide"}
                    >
                      {hiddenSet.has(key) ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                  )}
                  <button
                    disabled={i === 0}
                    onClick={() => onChange(moveKey(order, key, -1))}
                    className="p-1 rounded-inner text-secondary hover:text-accent disabled:opacity-30"
                    aria-label={`Move ${labels[key]} up`}
                  >
                    <ChevronUp size={14} />
                  </button>
                  <button
                    disabled={i === order.length - 1}
                    onClick={() => onChange(moveKey(order, key, 1))}
                    className="p-1 rounded-inner text-secondary hover:text-accent disabled:opacity-30"
                    aria-label={`Move ${labels[key]} down`}
                  >
                    <ChevronDown size={14} />
                  </button>
                </div>
                {onChangeSize && (
                  <div className="flex items-center gap-1 shrink-0">
                    {(["full", "half", "quarter"] as const).map((sz) => (
                      <button
                        key={sz}
                        onClick={() => onChangeSize(key, sz)}
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border ${
                          (sizes?.[key] ?? "half") === sz
                            ? "bg-accent text-white border-accent"
                            : "border-hairline text-secondary"
                        }`}
                        title={`${labels[key]}: ${sz}`}
                      >
                        {sz[0]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
