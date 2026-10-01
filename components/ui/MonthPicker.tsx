"use client";

import { t } from "@/lib/i18n";
import { currentMonth, localDateKey, monthBounds, type Month } from "@/lib/queries/dashboard";
import type { SaleRange } from "@/components/ui/DateRangePicker";

// How far back the chooser goes. Two years, matching how far back the
// Monthly Detail table and its year-earlier column already reach.
const MONTHS_OFFERED = 25;

export function monthLabel(m: Month): string {
  return new Date(m.year, m.month, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

// The chosen month as a date range, ending today if it is this month — so
// a chart does not draw the rest of the month as days of no sale.
export function monthAsRange(m: Month): SaleRange {
  const { from, to } = monthBounds(m);
  const now = new Date();
  return { from: localDateKey(from), to: localDateKey(to < now ? to : now) };
}

const keyOf = (m: Month) => `${m.year}-${m.month}`;

// The month a whole page shows (Sales, Dashboard). A plain select, styled
// like the Monthly Detail table's salesman picker beside it.
export function MonthPicker({ value, onChange }: { value: Month; onChange: (m: Month) => void }) {
  const now = currentMonth();
  const options: Month[] = [];
  for (let i = 0; i < MONTHS_OFFERED; i++) {
    const d = new Date(now.year, now.month - i, 1);
    options.push({ year: d.getFullYear(), month: d.getMonth() });
  }
  return (
    <select
      aria-label={t("ui.month")}
      className="px-2.5 py-1 rounded-card border border-hairline bg-surface text-caption font-semibold tabular-nums"
      value={keyOf(value)}
      onChange={(e) => {
        const picked = options.find((m) => keyOf(m) === e.target.value);
        if (picked) onChange(picked);
      }}
    >
      {options.map((m) => (
        <option key={keyOf(m)} value={keyOf(m)}>
          {monthLabel(m)}
        </option>
      ))}
    </select>
  );
}
