"use client";

import { useEffect, useState } from "react";

// Preset days-back values; -1/-2 are sentinels for the two calendar-anchored
// presets (Month to date, Year to date) that aren't a fixed day count.
const MTD = -1;
const YTD = -2;
export const SALE_RANGE_PRESETS: { label: string; days: number }[] = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "Month to date", days: MTD },
  { label: "Year to date", days: YTD },
];

export interface SaleRange {
  from: string; // ISO date, YYYY-MM-DD
  to: string;
}

export function presetToRange(days: number): SaleRange {
  const to = new Date();
  let from: Date;
  if (days === MTD) from = new Date(to.getFullYear(), to.getMonth(), 1);
  else if (days === YTD) from = new Date(to.getFullYear(), 0, 1);
  else {
    from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
  }
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function rangeLabel(range: SaleRange): string {
  const preset = SALE_RANGE_PRESETS.find((p) => {
    const r = presetToRange(p.days);
    return r.from === range.from && r.to === range.to;
  });
  if (preset) return preset.label;
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${fmt(range.from)} – ${fmt(range.to)}`;
}

// Full custom date-range selector (§Dashboard) — start/end date the user
// can pick directly, with the four common presets offered below it rather
// than instead of it. Shared by Dashboard's Average sale widget and Sales'
// adjustable orders/payments widgets.
export function DateRangePicker({ range, onChange }: { range: SaleRange; onChange: (r: SaleRange) => void }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);

  useEffect(() => {
    setDraftFrom(range.from);
    setDraftTo(range.to);
  }, [range.from, range.to]);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-card border border-hairline text-caption font-semibold text-secondary"
      >
        {rangeLabel(range)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 glass rounded-card shadow-floating z-50 p-3">
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {SALE_RANGE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => {
                    onChange(presetToRange(p.days));
                    setOpen(false);
                  }}
                  className="px-2.5 py-1.5 rounded-inner text-caption font-medium text-left hover:bg-accent/10 hover:text-accent transition"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="border-t border-hairline pt-2.5 flex items-center gap-2">
              <input
                type="date"
                value={draftFrom}
                max={draftTo}
                onChange={(e) => setDraftFrom(e.target.value)}
                className="min-w-0 flex-1 px-2 py-1.5 rounded-inner border border-hairline text-caption bg-canvas"
              />
              <span className="text-secondary text-caption">–</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDraftTo(e.target.value)}
                className="min-w-0 flex-1 px-2 py-1.5 rounded-inner border border-hairline text-caption bg-canvas"
              />
            </div>
            <button
              onClick={() => {
                onChange({ from: draftFrom, to: draftTo });
                setOpen(false);
              }}
              className="w-full mt-2.5 px-3 py-1.5 rounded-inner bg-accent text-white text-caption font-semibold"
            >
              Apply
            </button>
          </div>
        </>
      )}
    </div>
  );
}
