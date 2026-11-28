"use client";

import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { localDateKey } from "@/lib/queries/dashboard";

// Preset days-back values; -1/-2 are sentinels for the two calendar-anchored
// presets (Month to date, Year to date) that aren't a fixed day count.
const MTD = -1;
const YTD = -2;
const LAST_MONTH = -3;
export interface RangePreset {
  label: string;
  days: number;
}
export const SALE_RANGE_PRESETS: RangePreset[] = [
  { label: t("ui.range7Days"), days: 7 },
  { label: t("ui.range30Days"), days: 30 },
  { label: t("ui.rangeMonthToDate"), days: MTD },
  { label: t("ui.rangeYearToDate"), days: YTD },
];

// Reports (2026-11-28, owner: "year to date report exports, default dates +
// custom dates"): this month, the whole of last month, the year so far.
export const REPORT_RANGE_PRESETS: RangePreset[] = [
  { label: t("ui.rangeMonthToDate"), days: MTD },
  { label: t("ui.rangeLastMonth"), days: LAST_MONTH },
  { label: t("ui.rangeYearToDate"), days: YTD },
];

export interface SaleRange {
  from: string; // ISO date, YYYY-MM-DD
  to: string;
}

export function presetToRange(days: number): SaleRange {
  const to = new Date();
  let from: Date;
  if (days === LAST_MONTH) {
    return {
      from: localDateKey(new Date(to.getFullYear(), to.getMonth() - 1, 1)),
      to: localDateKey(new Date(to.getFullYear(), to.getMonth(), 0)),
    };
  }
  if (days === MTD) from = new Date(to.getFullYear(), to.getMonth(), 1);
  else if (days === YTD) from = new Date(to.getFullYear(), 0, 1);
  else {
    from = new Date(to);
    from.setDate(from.getDate() - (days - 1));
  }
  // Local dates. toISOString() gives the UTC date, and local midnight on the
  // 1st is still the previous day in UTC here — "Month to date" started on
  // the last day of the month before.
  return { from: localDateKey(from), to: localDateKey(to) };
}

// The range as instants on this device's clock: the first day from local
// midnight, the last day to the end of it. Both ends are included.
export function rangeInstants(range: SaleRange): { from: Date; to: Date } {
  return { from: new Date(`${range.from}T00:00:00`), to: new Date(`${range.to}T23:59:59.999`) };
}

export function rangeLabel(range: SaleRange, presets: RangePreset[] = SALE_RANGE_PRESETS): string {
  const preset = presets.find((p) => {
    const r = presetToRange(p.days);
    return r.from === range.from && r.to === range.to;
  });
  if (preset) return preset.label;
  const fmt = (d: string) => new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return t("ui.dateRange", { from: fmt(range.from), to: fmt(range.to) });
}

// Full custom date-range selector (§Dashboard) — start/end date the user
// can pick directly, with the four common presets offered below it rather
// than instead of it. Shared by Dashboard's Average sale widget and Sales'
// adjustable orders/payments widgets.
export function DateRangePicker({
  range,
  onChange,
  presets = SALE_RANGE_PRESETS,
}: {
  range: SaleRange;
  onChange: (r: SaleRange) => void;
  presets?: RangePreset[];
}) {
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
        {rangeLabel(range, presets)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute end-0 mt-2 w-72 glass rounded-card shadow-floating z-50 p-3">
            <div className="grid grid-cols-2 gap-1.5 mb-3">
              {presets.map((p) => (
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
              <span className="text-secondary text-caption">{t("ui.dateRangeSeparator")}</span>
              <input
                type="date"
                value={draftTo}
                min={draftFrom}
                max={localDateKey(new Date())}
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
              {t("ui.apply")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
