"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchTopCustomers,
  fetchSalesByMonth,
  fetchSaleTrend,
  fetchPaymentsSummary,
  fetchExpenseBreakdown,
  fetchSalesByCategory,
  type TopCustomer,
  type MonthPoint,
  type DailyPoint,
} from "@/lib/queries/dashboard";
import { fetchLeaderboard } from "@/lib/queries/sales";
import { fetchMonthlyTargets, FALLBACK_MONTHLY_TARGET } from "@/lib/queries/targets";
import { DonutChart } from "@/components/ui/charts";
import { formatAed } from "@/lib/money";
import { Card } from "@/components/ui/Card";
import { TrendLineChart, MonthlyBarChart } from "@/components/ui/charts";
import { tintForLabel } from "@/lib/categoryColors";
import { usePreferences } from "@/lib/hooks/usePreferences";

// §Global Arrange: "users can take widgets from OTHER tabs (e.g. take the
// detailed sale widget from Sales tab and put it in Dashboard). Widgets are
// categorized."
//
// Every widget in this catalogue is deliberately self-contained — it fetches
// its own data and takes no props — which is what makes it safe to drop onto
// any tab. Page-specific widgets that depend on their page's local state
// (the Dashboard's own date-range-linked ones, say) stay where they are.

export type WidgetCategory = "Sales" | "Customers" | "Products" | "Payments" | "Expense";

export interface CatalogWidget {
  key: string;
  label: string;
  category: WidgetCategory;
  // Which tab it normally lives on — shown in the gallery so it's obvious
  // you're borrowing from somewhere else.
  from: string;
  render: () => React.ReactNode;
}

function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let cancelled = false;
    fn()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return data;
}

function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-8 skeleton rounded-inner" />
      ))}
    </div>
  );
}

function TopCustomersWidget() {
  const { preferences } = usePreferences();
  const colorful = preferences.colorfulData === true;
  const rows = useLoad<TopCustomer[]>(() => fetchTopCustomers(supabaseBrowser(), { limit: 6 }));
  const max = rows?.length ? Math.max(...rows.map((r) => r.total)) : 0;

  return (
    <Card className="p-4">
      <div className="text-title font-bold mb-3">Top customers</div>
      {rows === null ? (
        <SkeletonRows />
      ) : rows.length === 0 ? (
        <div className="text-center text-subhead text-secondary py-8">No sales this month yet</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.customerId} className="relative rounded-inner overflow-hidden bg-canvas">
              <div
                className={`absolute inset-y-0 left-0 ${colorful ? "" : "bg-accent/15"}`}
                style={{
                  width: max > 0 ? `${(r.total / max) * 100}%` : "0%",
                  ...(colorful ? { background: tintForLabel(r.name, 0.22) } : {}),
                }}
              />
              <div className="relative flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-subhead font-medium truncate">{r.name}</span>
                <span className="text-subhead font-semibold tabular-nums shrink-0">{formatAed(r.total)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function YearComparisonWidget() {
  const data = useLoad<{ thisYear: MonthPoint[]; lastYear: MonthPoint[] }>(async () => {
    const supabase = supabaseBrowser();
    const [thisYear, lastYear] = await Promise.all([
      fetchSalesByMonth(supabase, {}),
      fetchSalesByMonth(supabase, { yearsAgo: 1 }),
    ]);
    return { thisYear, lastYear };
  });

  return (
    <Card className="p-4">
      <div className="text-title font-bold mb-3">Sale · year comparison</div>
      {data === null ? (
        <SkeletonRows n={3} />
      ) : (
        <MonthlyBarChart
          bars={data.thisYear.map((m, i) => ({
            label: m.label,
            segments: [
              { value: m.value, color: "var(--accent)" },
              { value: data.lastYear[i]?.value ?? 0, color: "#8e8e93" },
            ],
          }))}
        />
      )}
    </Card>
  );
}

function SaleTrendWidget() {
  const trend = useLoad<DailyPoint[]>(() => fetchSaleTrend(supabaseBrowser(), { days: 30 }));
  return (
    <Card className="p-4">
      <div className="text-title font-bold mb-3">Sale trend · 30 days</div>
      {trend === null ? (
        <SkeletonRows n={3} />
      ) : (
        <TrendLineChart values={trend.map((t) => t.value)} height={180} showAverage />
      )}
    </Card>
  );
}

// Ordered so the gallery groups cleanly.

// --- Detailed sales report -------------------------------------------------
// The Sales page's Monthly Detail table, self-contained so it can sit on any
// tab. Explicitly requested: "if I want the detailed sales report widget in
// the dashboard, I can choose it from the Sales category."
function DetailedSalesWidget() {
  const rows = useLoad(async () => {
    const supabase = supabaseBrowser();
    const [thisYear, lastYear, targets] = await Promise.all([
      fetchSalesByMonth(supabase, {}),
      fetchSalesByMonth(supabase, { yearsAgo: 1 }),
      fetchMonthlyTargets(supabase),
    ]);
    const target = targets.fallback || FALLBACK_MONTHLY_TARGET;
    return thisYear.map((m, i) => ({
      label: m.label,
      sale: m.value,
      past: lastYear[i]?.value ?? 0,
      target,
    }));
  });

  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-title font-bold mb-3 shrink-0">Detailed sales</div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        <table className="w-full text-caption">
          <thead>
            <tr className="text-secondary uppercase text-left sticky top-0 bg-surface">
              <th className="py-1.5 font-medium">Month</th>
              <th className="py-1.5 font-medium text-right">Sale</th>
              <th className="py-1.5 font-medium text-right">Tgt%</th>
              <th className="py-1.5 font-medium text-right">Past yr</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((m) => (
              <tr key={m.label} className="border-t border-hairline">
                <td className="py-1.5 font-semibold">{m.label}</td>
                <td className="py-1.5 text-right tabular-nums">{formatAed(m.sale)}</td>
                <td className="py-1.5 text-right tabular-nums text-secondary">
                  {m.target > 0 ? `${Math.round((m.sale / m.target) * 100)}%` : "—"}
                </td>
                <td className="py-1.5 text-right tabular-nums text-secondary">{formatAed(m.past)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// --- Goal leaderboard ------------------------------------------------------
function GoalLeaderboardWidget() {
  const data = useLoad(async () => {
    const supabase = supabaseBrowser();
    const [entries, targets] = await Promise.all([
      fetchLeaderboard(supabase),
      fetchMonthlyTargets(supabase),
    ]);
    return entries.map((e) => ({ ...e, target: targets.forUser(e.salesmanId) }));
  });
  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-title font-bold mb-3 shrink-0">Goal</div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
        {(data ?? []).map((e) => {
          const pct = e.target > 0 ? Math.min(100, (e.total / e.target) * 100) : 0;
          return (
            <div key={e.salesmanId} className="rounded-inner bg-accent/10 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-subhead font-bold truncate">{e.name}</span>
                <span className="text-subhead font-bold tabular-nums text-accent shrink-0">
                  {Math.round(pct)}%
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-canvas overflow-hidden mt-1.5">
                <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// --- Payments summary ------------------------------------------------------
function PaymentsSummaryWidget() {
  const s = useLoad(() => fetchPaymentsSummary(supabaseBrowser()));
  const rows = [
    { label: "Collected", value: s?.received ?? 0, cls: "text-accent" },
    { label: "Remaining", value: s?.remaining ?? 0, cls: "text-secondary" },
    { label: "Overdue", value: s?.overdue ?? 0, cls: "text-[--status-danger]" },
  ];
  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-title font-bold mb-3 shrink-0">Payments</div>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-2">
            <span className="text-subhead text-secondary">{r.label}</span>
            <span className={`text-title font-bold tabular-nums ${r.cls}`}>{formatAed(r.value)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- Expense breakdown -----------------------------------------------------
function ExpenseBreakdownWidget() {
  const d = useLoad(() => fetchExpenseBreakdown(supabaseBrowser()));
  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-title font-bold mb-3 shrink-0">Expense</div>
      <div className="flex-1 min-h-0 flex items-center">
        <DonutChart
          slices={d?.slices ?? []}
          total={d?.total ?? 0}
          size={196}
          centerLabel={d ? formatAed(d.total).replace("AED ", "") : ""}
        />
      </div>
    </Card>
  );
}

// --- Sales by category -----------------------------------------------------
function SalesByCategoryWidget() {
  const rows = useLoad(() => fetchSalesByCategory(supabaseBrowser(), {}));
  const max = Math.max(1, ...(rows ?? []).map((r) => r.value));
  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-title font-bold mb-3 shrink-0">Sales by category</div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-1.5">
        {(rows ?? []).slice(0, 12).map((r) => (
          <div key={r.label} className="relative rounded-inner overflow-hidden px-3 py-2">
            <div
              className="absolute inset-y-0 left-0 rounded-inner"
              style={{ width: `${(r.value / max) * 100}%`, background: tintForLabel(r.label) }}
            />
            <div className="relative flex items-center justify-between gap-2">
              <span className="text-subhead font-semibold truncate">{r.label}</span>
              <span className="text-subhead font-bold tabular-nums shrink-0">{formatAed(r.value)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export const WIDGET_CATALOG: CatalogWidget[] = [
  { key: "cat:saleTrend", label: "Sale trend", category: "Sales", from: "Sales", render: () => <SaleTrendWidget /> },
  { key: "cat:yearComparison", label: "Year comparison", category: "Sales", from: "Sales", render: () => <YearComparisonWidget /> },
  { key: "cat:detailedSales", label: "Detailed sales report", category: "Sales", from: "Sales", render: () => <DetailedSalesWidget /> },
  { key: "cat:goal", label: "Goal leaderboard", category: "Sales", from: "Sales", render: () => <GoalLeaderboardWidget /> },
  { key: "cat:salesByCategory", label: "Sales by category", category: "Sales", from: "Dashboard", render: () => <SalesByCategoryWidget /> },
  { key: "cat:topCustomers", label: "Top customers", category: "Customers", from: "Customers", render: () => <TopCustomersWidget /> },
  { key: "cat:paymentsSummary", label: "Payments summary", category: "Payments", from: "Payments", render: () => <PaymentsSummaryWidget /> },
  { key: "cat:expense", label: "Expense breakdown", category: "Expense", from: "Expense", render: () => <ExpenseBreakdownWidget /> },
];

export const CATALOG_BY_KEY = new Map(WIDGET_CATALOG.map((w) => [w.key, w]));

// A borrowed widget's key is namespaced with "cat:" so it can never collide
// with a page's own widget ids.
export function isCatalogKey(key: string): boolean {
  return key.startsWith("cat:");
}
