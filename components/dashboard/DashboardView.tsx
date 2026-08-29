"use client";

import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { springLayout } from "@/lib/motion";
import { motion } from "framer-motion";
import { useRouter } from "next/navigation";
import { Plus, TrendingUp, TrendingDown, ArrowRight, ArrowDownUp } from "lucide-react";
import Sheet from "@/components/ui/Sheet";
import { WidgetAdjustPopover, resolveOrder, SIZE_SPAN, type WidgetSize } from "@/components/ui/WidgetArrange";
import { ArrangeGrid } from "@/components/ui/ArrangeGrid";
import { CATALOG_BY_KEY, isCatalogKey } from "@/components/widgets/catalog";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { useDisplayCurrency } from "@/lib/hooks/useDisplayCurrency";
import {
  monthToDateSales,
  monthToDateGrossProfit,
  countByStatus,
  countOrdersThisMonth,
  fetchSaleTrend,
  fetchPaymentsByMonthSegmented,
  fetchSalesByMonth,
  fetchExpenseBreakdown,
  fetchPaymentsSummary,
  fetchSalesByCategory,
  type DailyPoint,
  type MonthPoint,
  type MonthSegments,
  type ExpenseSlice,
  type PaymentsSummary,
  type CategorySale,
} from "@/lib/queries/dashboard";
import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/queries/sales";
import { fetchMonthlyTargets, teamTarget, FALLBACK_MONTHLY_TARGET, type MonthlyTargets } from "@/lib/queries/targets";
import { SalesmanDrilldown, ExpandedStatRow } from "@/components/sales/SalesmanDrilldown";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import type { AppUser } from "@/lib/types/db";
import { formatAed, formatCompact } from "@/lib/money";
import { tintForLabel, colorForLabel } from "@/lib/categoryColors";
import { Card } from "@/components/ui/Card";
import AnimatedNumber from "@/components/ui/AnimatedNumber";
import Button from "@/components/ui/Button";
import PageFooterActions from "@/components/ui/PageFooterActions";
import { TrendLineChart, MonthlyBarChart, DonutChart } from "@/components/ui/charts";
import NewOrderSheet from "@/components/orders/NewOrderSheet";
import { DateRangePicker, presetToRange, rangeLabel, type SaleRange } from "@/components/ui/DateRangePicker";

function StatTile({
  label,
  value,
  numeric,
  format,
  sub,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  // Pass `numeric` + `format` instead of a pre-formatted `value` to have the
  // figure count into place on load and whenever it changes.
  numeric?: number;
  format?: (n: number) => string;
  sub?: string;
  tone?: "warning" | "danger";
  // Quarter-widgets redirect to their relevant tab when clicked (§Next
  // Updates dashboard: Sale/Orders/GP/Profit -> Sales, Pending/Waiting/
  // Packed -> Orders).
  onClick?: () => void;
}) {
  return (
    <Card
      className={`p-3.5 min-w-[110px] ${onClick ? "cursor-pointer hover:brightness-95 dark:hover:brightness-125 transition" : ""}`}
      onClick={onClick}
    >
      <div className="text-caption text-secondary truncate">{label}</div>
      <div
        className={`text-title font-bold mt-1 tabular-nums ${
          tone === "warning" ? "text-[--status-warning]" : tone === "danger" ? "text-[--status-danger]" : ""
        }`}
      >
        {numeric !== undefined && format ? (
          <AnimatedNumber value={numeric} format={format} />
        ) : (
          value
        )}
      </div>
      {sub && <div className="text-caption text-secondary mt-0.5">{sub}</div>}
    </Card>
  );
}

// A single card with colored, densely-packed rows — one per status/metric
// — replacing what used to be 3-4 separate half-empty StatTiles. Matches
// the original mockup's compact "Pending / Waiting / Packed" block.
function StatusPipeline({
  rows,
  onClick,
}: {
  rows: { label: string; value: string; tone: "warning" | "accent" | "info" | "danger" | "neutral" }[];
  onClick?: () => void;
}) {
  const toneClasses: Record<string, string> = {
    warning: "bg-warning/15 text-[--status-warning]",
    accent: "bg-accent/15 text-accent",
    info: "bg-info/15 text-[--status-info]",
    danger: "bg-danger/15 text-[--status-danger]",
    neutral: "bg-black/[0.04] dark:bg-white/[0.06] text-secondary",
  };
  return (
    <Card
      // Always side-by-side — the iPhone mockup draws Pending/Waiting/Packed
      // as three cards across, not stacked.
      className={`p-2 flex flex-row gap-1.5 sm:gap-2 ${onClick ? "cursor-pointer hover:brightness-95 dark:hover:brightness-125 transition" : ""}`}
      onClick={onClick}
    >
      {rows.map((r) => (
        <div
          key={r.label}
          className={`flex-1 min-w-0 flex flex-col items-center sm:flex-row sm:items-center sm:justify-between px-2 sm:px-3 py-2 sm:py-2.5 rounded-inner ${toneClasses[r.tone]}`}
        >
          <span className="text-caption font-semibold truncate">{r.label}</span>
          <span className="text-headline font-bold tabular-nums">{r.value}</span>
        </div>
      ))}
    </Card>
  );
}

// One column of the phone's packed stat strip.
function CompactStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-caption text-secondary truncate">{label}</div>
      <div className="text-headline font-bold tabular-nums text-accent truncate">{value}</div>
    </div>
  );
}

function ChangeBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-caption font-semibold px-1.5 py-0.5 rounded-full ${
        up ? "bg-accent/12 text-accent" : "bg-danger/12 text-[--status-danger]"
      }`}
    >
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {Math.abs(Math.round(pct * 100))}%
    </span>
  );
}

function TargetBar({ sale, target }: { sale: number; target: number }) {
  const pct = target > 0 ? Math.min(1, sale / target) : 0;
  const leftPct = Math.max(0, 1 - pct);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-caption text-secondary">Target</span>
        <span className="text-caption text-secondary">Left to target</span>
      </div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-title font-bold tabular-nums">{formatAed(target)}</span>
        <span className="text-title font-bold tabular-nums text-accent">{Math.round(leftPct * 100)}%</span>
      </div>
      <div className="h-2 rounded-full bg-canvas overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </Card>
  );
}

function LeaderboardStrip({
  entries,
  youId,
  showAll,
}: {
  entries: LeaderboardEntry[];
  youId?: string;
  showAll?: boolean;
}) {
  if (entries.length === 0) return null;
  return (
    <Card className="p-3 h-full flex flex-col">
      <div className="text-title font-bold px-1 pb-2.5 shrink-0">Salesman</div>
      <div className="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto">
        {(showAll ? entries : entries.slice(0, 6)).map((e) => (
          <div
            key={e.salesmanId}
            className={`flex items-center justify-between px-3.5 py-2.5 rounded-inner ${
              e.salesmanId === youId ? "bg-accent/20" : "bg-accent/10"
            }`}
          >
            <span className="text-headline font-bold truncate">{e.name}</span>
            <span className="text-headline font-bold tabular-nums shrink-0 text-accent">{formatAed(e.total)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// Half/quarter widgets enlarge into a full Sheet on click (§Next Updates:
// "Average sale/Payments/Expense/Leaderboard half-widgets enlarge on
// click") — `expanded` lets the caller swap in a bigger-scaled version of
// the same chart (larger donut radius, taller bars) rather than reusing the
// cramped inline size.
function ExpandableWidget({
  title,
  children,
  expanded,
}: {
  title: string;
  children: ReactNode;
  expanded?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        className="cursor-pointer hover:brightness-95 dark:hover:brightness-125 transition rounded-card"
        onClick={(e) => {
          // Nested controls (date-range button, StatusPipeline/StatTile
          // "go to page" cards, etc.) keep their own click behavior instead
          // of also opening this widget's enlarged view.
          const target = e.target as HTMLElement;
          if (target.closest('button, a, input, select, textarea, [role="button"]')) return;
          setOpen(true);
        }}
      >
        {children}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={title}>
        {expanded ?? children}
      </Sheet>
    </>
  );
}

// Enlarged "Sale" widget (§Next Updates dashboard mockup): chart+comparison
// line on the left, a stats column on the right (Total/Avg Sale, GP, GP%,
// Profit, top contributor), with a link through to the full Sales page.
function SaleExpanded({
  trend,
  prevTrend,
  saleRange,
  onChangeRange,
  totalSale,
  avgSale,
  totalGp,
  totalProfit,
  leaderboard,
  onNavigateSales,
}: {
  trend: DailyPoint[];
  prevTrend: DailyPoint[];
  saleRange: SaleRange;
  onChangeRange: (r: SaleRange) => void;
  totalSale: number;
  avgSale: number;
  totalGp: number;
  totalProfit: number;
  leaderboard: LeaderboardEntry[];
  onNavigateSales: () => void;
}) {
  const gpPct = totalSale > 0 ? (totalGp / totalSale) * 100 : 0;
  const topContributor = leaderboard[0];
  return (
    <div className="grid lg:grid-cols-[1fr_260px] gap-4 items-start">
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <span className="text-title font-bold">Sale</span>
          <DateRangePicker range={saleRange} onChange={onChangeRange} />
        </div>
        <TrendLineChart
          values={trend.map((t) => t.value)}
          compareValues={prevTrend.map((t) => t.value)}
          height={280}
          showAverage
        />
      </Card>
      <div className="flex flex-col gap-3">
        <Card className="p-4">
          <ExpandedStatRow label="Total Sale" value={formatAed(totalSale)} />
          <ExpandedStatRow label="Avg. Sale" value={formatAed(avgSale)} />
        </Card>
        {totalGp > 0 && (
          <Card className="p-4">
            <ExpandedStatRow label="Total GP" value={formatAed(totalGp)} />
            <ExpandedStatRow label="GP %" value={`${Math.round(gpPct)}%`} />
          </Card>
        )}
        {totalProfit !== 0 && (
          <Card className="p-4">
            <ExpandedStatRow label="Total Profit" value={formatAed(totalProfit)} />
          </Card>
        )}
        {leaderboard.length > 0 && (
          <Card className="p-4">
            <div className="text-subhead font-semibold mb-2">Leading Contributors</div>
            {topContributor && (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-inner bg-accent/12">
                <span className="text-headline font-bold truncate">{topContributor.name}</span>
                <span className="text-headline font-bold tabular-nums text-accent shrink-0">
                  {formatAed(topContributor.total)}
                </span>
              </div>
            )}
          </Card>
        )}
        <Button tier="plain" onClick={onNavigateSales} className="self-end flex items-center gap-1">
          Sales <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}

// Enlarged "Payments" widget: chart left, Collected/Remaining/Overdue right.
function PaymentsExpanded({
  paymentsByMonth,
  summary,
  onNavigatePayments,
}: {
  paymentsByMonth: MonthSegments[];
  summary: PaymentsSummary;
  onNavigatePayments: () => void;
}) {
  return (
    <div className="grid lg:grid-cols-[1fr_240px] gap-4 items-start">
      <Card className="p-4">
        <div className="text-title font-bold mb-3">Payments</div>
        <MonthlyBarChart
          height={280}
          bars={paymentsByMonth.map((m) => ({
            label: m.label,
            segments: [
              { value: m.cleared, color: "var(--accent)" },
              { value: m.other, color: "#8e8e93" },
              { value: m.bounced, color: "var(--status-danger)" },
            ],
          }))}
        />
      </Card>
      <div className="flex flex-col gap-3">
        <Card className="p-4 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-subhead font-semibold text-accent">Collected</span>
            <span className="text-headline font-bold tabular-nums text-accent">{formatAed(summary.received)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-subhead font-semibold text-secondary">Remaining</span>
            <span className="text-headline font-bold tabular-nums text-secondary">{formatAed(summary.remaining)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-subhead font-semibold text-[--status-danger]">Overdue</span>
            <span className="text-headline font-bold tabular-nums text-[--status-danger]">{formatAed(summary.overdue)}</span>
          </div>
        </Card>
        <Button tier="plain" onClick={onNavigatePayments} className="self-end flex items-center gap-1">
          Payments <ArrowRight size={14} />
        </Button>
      </div>
    </div>
  );
}

// Enlarged "Expense" widget: legend on the left, bigger donut on the right
// (§Next Updates mockup — the compact widget has the legend on the right of
// a small ring; the enlarged one flips to legend-left, big-ring-right).
function ExpenseExpanded({
  slices,
  total,
  onNavigateExpense,
}: {
  slices: ExpenseSlice[];
  total: number;
  onNavigateExpense: () => void;
}) {
  const { preferences } = usePreferences();
  const colorful = preferences.colorfulData === true;
  // The mockup gives every expense type its own hue. With "colorful data"
  // on, that hue comes from the shared per-label palette so a category is
  // the same colour here as everywhere else; otherwise the chart's own
  // series colours are used.
  const colorAt = (label: string, i: number) =>
    colorful
      ? colorForLabel(label)
      : ["var(--accent)", "var(--status-info)", "var(--status-warning)", "var(--status-danger)", "#8e8e93", "#af52de"][i % 6];

  return (
    <Card className="p-4">
      <div className="text-title font-bold mb-4">Expense</div>
      <div className="flex items-center justify-between gap-6 flex-wrap">
        {/* Two-column legend with square swatches, as drawn. */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-3">
          {slices.map((s, i) => (
            <div key={s.label} className="flex items-center gap-2.5">
              <span className="w-4 h-4 rounded-well shrink-0" style={{ background: colorAt(s.label, i) }} />
              <span className="text-subhead font-medium">{s.label}</span>
            </div>
          ))}
        </div>
        <DonutChart
          slices={colorful ? slices.map((s) => ({ ...s, color: colorForLabel(s.label) })) : slices}
          total={total}
          size={220}
          centerLabel={formatCompact(total)}
          showLegend={false}
        />
      </div>
      <div className="flex justify-end mt-4">
        <Button tier="plain" onClick={onNavigateExpense} className="flex items-center gap-1">
          Expense <ArrowRight size={14} />
        </Button>
      </div>
    </Card>
  );
}

// Enlarged "Goal"/leaderboard widget: a real table (§Next Updates mockup) —
// team summary row on top, one row per salesman below, click a row to drill
// into that salesman's own stats.
function GoalTableExpanded({
  entries,
  targets,
  onOpenSalesman,
}: {
  entries: LeaderboardEntry[];
  targets: MonthlyTargets | null;
  onOpenSalesman: (e: LeaderboardEntry) => void;
}) {
  const goalFor = (id: string) => (targets ? targets.forUser(id) : FALLBACK_MONTHLY_TARGET);
  const teamTotal = entries.reduce((s, e) => s + e.total, 0);
  // The team goal is the sum of each person's own goal, not head-count times
  // a flat number — those differ as soon as anyone has a different target.
  const teamGoal = targets ? teamTarget(targets, entries.map((e) => e.salesmanId)) : entries.length * FALLBACK_MONTHLY_TARGET;
  const teamPct = teamGoal > 0 ? (teamTotal / teamGoal) * 100 : 0;

  // §mockup: the ↓↑ pill above the table flips best-first / worst-first.
  const [ascending, setAscending] = useState(false);
  const sorted = [...entries].sort((a, b) => (ascending ? a.total - b.total : b.total - a.total));

  if (entries.length === 0) return <EmptyStateInline text="No sales yet this month" />;

  return (
    <Card className="p-4 overflow-x-auto">
      <div className="grid grid-cols-5 gap-3 mb-4 min-w-[520px]">
        <HeaderStat label="Total%" value={`${Math.round(teamPct)}%`} />
        <HeaderStat label="Total" value={formatCompact(teamTotal)} />
        <HeaderStat label="% to goal" value={`${Math.max(0, Math.round(100 - teamPct))}%`} />
        <HeaderStat label="Amt. to Goal" value={formatCompact(Math.max(0, teamGoal - teamTotal))} />
        <HeaderStat label="Goal" value={formatCompact(teamGoal)} />
      </div>
      <div className="flex justify-end min-w-[520px]">
        <button
          onClick={() => setAscending((v) => !v)}
          className="w-7 h-7 rounded-full bg-canvas border border-hairline grid place-items-center text-secondary hover:text-primary transition-colors"
          title={ascending ? "Showing lowest first — tap for highest first" : "Showing highest first — tap for lowest first"}
          aria-label="Toggle sort order"
        >
          <ArrowDownUp size={13} />
        </button>
      </div>
      <table className="w-full text-subhead min-w-[520px]">
        <thead>
          <tr className="text-caption text-secondary uppercase text-left">
            <th className="pb-2 font-medium">Salesman</th>
            <th className="pb-2 font-medium text-right">Sale%</th>
            <th className="pb-2 font-medium text-right">Sale</th>
            <th className="pb-2 font-medium text-right">% to goal</th>
            <th className="pb-2 font-medium text-right">Goal</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e) => {
            const goal = goalFor(e.salesmanId);
            const pct = goal > 0 ? (e.total / goal) * 100 : 0;
            return (
              <tr key={e.salesmanId}>
                <td className="py-1.5">
                  <button
                    onClick={() => onOpenSalesman(e)}
                    className="w-full text-left px-3 py-2 rounded-inner bg-accent/10 hover:bg-accent/20 font-bold truncate"
                  >
                    {e.name}
                  </button>
                </td>
                <td className="py-1.5 text-right font-bold tabular-nums text-accent">{Math.round(pct)}%</td>
                <td className="py-1.5 text-right font-bold tabular-nums text-accent">{formatAed(e.total)}</td>
                <td className="py-1.5 text-right font-bold tabular-nums">{Math.max(0, Math.round(100 - pct))}%</td>
                <td className="py-1.5 text-right font-bold tabular-nums">{formatAed(goal)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-secondary font-semibold">{label}</div>
      <div className="text-headline font-bold tabular-nums text-accent truncate">{value}</div>
    </div>
  );
}

function EmptyStateInline({ text }: { text: string }) {
  return <div className="text-center text-subhead text-secondary py-8">{text}</div>;
}

// §Dashboard: category/product-wise sales report. Ranked bars rather than a
// donut — a catalogue this size has far too many categories for a readable
// pie, and the useful question here is "which sell most", which reads better
// as a sorted list.
function CategorySalesWidget({ salesmanId }: { salesmanId?: string }) {
  const { preferences } = usePreferences();
  const colorful = preferences.colorfulData === true;
  const [groupBy, setGroupBy] = useState<"category" | "product">("category");
  const [rows, setRows] = useState<CategorySale[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    fetchSalesByCategory(supabaseBrowser(), { groupBy, salesmanId })
      .then((r) => !cancelled && setRows(r))
      .catch(() => !cancelled && setRows([]));
    return () => {
      cancelled = true;
    };
  }, [groupBy, salesmanId]);

  const max = rows && rows.length ? Math.max(...rows.map((r) => r.value)) : 0;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <span className="text-title font-bold">Sales by {groupBy}</span>
        <div className="flex items-center gap-1">
          {(["category", "product"] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-2.5 py-1 rounded-card text-caption font-semibold border transition-colors ${
                groupBy === g ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              {g === "category" ? "Category" : "Product"}
            </button>
          ))}
        </div>
      </div>
      {rows === null ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-8 skeleton rounded-inner" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyStateInline text="No sales this month yet" />
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.label} className="relative rounded-inner overflow-hidden bg-canvas">
              <div
                className={`absolute inset-y-0 left-0 ${colorful ? "" : "bg-accent/15"}`}
                style={{
                  width: max > 0 ? `${(r.value / max) * 100}%` : "0%",
                  ...(colorful ? { background: tintForLabel(r.label, 0.22) } : {}),
                }}
              />
              <div className="relative flex items-center justify-between gap-3 px-3 py-2">
                <span className="text-subhead font-medium truncate">{r.label}</span>
                <span className="flex items-center gap-3 shrink-0 tabular-nums">
                  <span className="text-caption text-secondary">{r.units} u</span>
                  <span className="text-subhead font-semibold">{formatAed(r.value)}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const MANAGER_WIDGETS = ["stats", "pipeline", "avgSale", "payments", "expense", "leaderboard", "categorySales"] as const;
// Off unless the user turns it on in Arrange (§Dashboard: "add a category/
// product-wise sales report widget, hidden by default, optional").
const DEFAULT_HIDDEN_MANAGER_WIDGETS: (typeof MANAGER_WIDGETS)[number][] = ["categorySales"];
const MANAGER_WIDGET_LABELS: Record<(typeof MANAGER_WIDGETS)[number], string> = {
  stats: "Sales & profit summary",
  pipeline: "Order pipeline counts",
  avgSale: "Average sale trend",
  payments: "Payments by month",
  expense: "Expense breakdown",
  leaderboard: "Salesman leaderboard",
  categorySales: "Sales by category / product",
};
// Widgets that always take the full row; everything else pairs up
// side-by-side on wide screens and stacks single-column on narrow ones
// (§Dashboard: "when expanded the screen it should be split... if small,
// single line layout instead of split").
const MANAGER_WIDGET_FULL: Record<(typeof MANAGER_WIDGETS)[number], boolean> = {
  stats: true,
  pipeline: true,
  avgSale: false,
  payments: false,
  expense: false,
  // Half-width, pairs beside Expense by default (§dashboard mockups: the
  // salesman leaderboard is a half-width card next to Expense, not full).
  leaderboard: false,
  categorySales: true,
};

const SALESMAN_WIDGETS = ["stats", "newOrder", "pipeline", "payments3", "target", "trend", "monthly", "leaderboard"] as const;
const SALESMAN_WIDGET_LABELS: Record<(typeof SALESMAN_WIDGETS)[number], string> = {
  stats: "Sales summary",
  newOrder: "New order button",
  pipeline: "Draft/Waiting/Approved counts",
  payments3: "Payments breakdown",
  target: "Target progress",
  trend: "Sale trend chart",
  monthly: "Payments & year-comparison charts",
  leaderboard: "Salesman leaderboard",
};
const SALESMAN_WIDGET_FULL: Record<(typeof SALESMAN_WIDGETS)[number], boolean> = {
  stats: true,
  newOrder: true,
  pipeline: true,
  payments3: true,
  target: false,
  trend: false,
  monthly: true,
  leaderboard: true,
};


export default function DashboardView({ user }: { user: AppUser }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  // Clicking a salesman row inside the enlarged leaderboard/goal table
  // drills into their own trend + orders (§Next Updates: individual
  // "Salesman Name" expanded view).
  const [drilldownSalesman, setDrilldownSalesman] = useState<LeaderboardEntry | null>(null);
  const [targets, setTargets] = useState<MonthlyTargets | null>(null);
  // Apple-widgets style edit mode (§Global Arrange).
  const [arranging, setArranging] = useState(false);
  const { preferences, update: updatePrefs, loaded: prefsLoaded } = usePreferences();
  const { format: formatMoney } = useDisplayCurrency();
  const [saleRange, setSaleRange] = useState<SaleRange>(() => presetToRange(30));

  useEffect(() => {
    if (!prefsLoaded) return;
    if (preferences.averageSaleFrom && preferences.averageSaleTo) {
      setSaleRange({ from: preferences.averageSaleFrom, to: preferences.averageSaleTo });
    } else if (preferences.averageSaleRangeDays) {
      setSaleRange(presetToRange(preferences.averageSaleRangeDays));
    }
  }, [prefsLoaded, preferences.averageSaleFrom, preferences.averageSaleTo, preferences.averageSaleRangeDays]);

  function changeSaleRange(range: SaleRange) {
    setSaleRange(range);
    updatePrefs({ averageSaleFrom: range.from, averageSaleTo: range.to });
  }

  const managerOrder = useMemo(
    () => {
      const own = resolveOrder(MANAGER_WIDGETS, preferences.dashboardLayout);
      // Borrowed widgets aren't in MANAGER_WIDGETS, so resolveOrder drops
      // them — re-insert them at the position the user left them in.
      const stored = preferences.dashboardLayout ?? [];
      const borrowed = stored.filter((k) => isCatalogKey(k) && CATALOG_BY_KEY.has(k));
      if (borrowed.length === 0) return own as string[];
      const merged: string[] = [];
      for (const k of stored) {
        if (isCatalogKey(k)) { if (CATALOG_BY_KEY.has(k)) merged.push(k); }
        else if ((own as string[]).includes(k)) merged.push(k);
      }
      for (const k of own as string[]) if (!merged.includes(k)) merged.push(k);
      return merged;
    },
    [preferences.dashboardLayout]
  );
  // Widgets the user has switched off in Arrange. Falls back to the
  // hidden-by-default set the first time, so an optional widget stays off
  // until it's explicitly turned on.
  // Per-widget Full/Half/Quarter, defaulting to the layout each widget
  // already had (§Global: standardized widget sizes, user-adjustable).
  const managerSizes = useMemo(() => {
    const stored = (preferences.dashboardSizes ?? {}) as Record<string, WidgetSize>;
    const out = {} as Record<string, WidgetSize>;
    for (const k of MANAGER_WIDGETS) {
      out[k] = stored[k] ?? (MANAGER_WIDGET_FULL[k] ? "full" : "half");
    }
    for (const k of CATALOG_BY_KEY.keys()) out[k] = stored[k] ?? "half";
    return out;
  }, [preferences.dashboardSizes]);

  const hiddenManagerWidgets = useMemo<string[]>(
    () =>
      ((preferences.dashboardHidden as string[] | undefined) ??
        (DEFAULT_HIDDEN_MANAGER_WIDGETS as string[])).filter(
        (k) => (MANAGER_WIDGETS as readonly string[]).includes(k) || isCatalogKey(k)
      ),
    [preferences.dashboardHidden]
  );
  const salesmanOrder = useMemo(
    () => resolveOrder(SALESMAN_WIDGETS, preferences.dashboardLayout),
    [preferences.dashboardLayout]
  );

  // manager
  const [sales, setSales] = useState(0);
  const [prevSales, setPrevSales] = useState(0);
  const [gp, setGp] = useState(0);
  const [expenseSlices, setExpenseSlices] = useState<ExpenseSlice[]>([]);
  const [expenseTotal, setExpenseTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [waiting, setWaiting] = useState(0);
  const [packed, setPacked] = useState(0);
  const [drafts, setDrafts] = useState(0);
  const [approved, setApproved] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [ordersThisMonth, setOrdersThisMonth] = useState(0);
  const [toPick, setToPick] = useState(0);
  const [packedAwaiting, setPackedAwaiting] = useState(0);
  const [trend, setTrend] = useState<DailyPoint[]>([]);
  // Previous-period trend (§Next Updates: the enlarged Sale/trend view shows
  // two comparison lines) — same length as saleRange, immediately preceding
  // it, so "this 30 days" overlays against "the 30 days before that".
  const [prevTrend, setPrevTrend] = useState<DailyPoint[]>([]);
  const [paymentsByMonth, setPaymentsByMonth] = useState<MonthSegments[]>([]);
  const [salesByMonth, setSalesByMonth] = useState<MonthPoint[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [paySummary, setPaySummary] = useState<PaymentsSummary>({ pendingCount: 0, received: 0, overdue: 0, remaining: 0 });

  const isManager = (user.role === "manager" || user.role === "admin");
  const isSalesman = user.role === "salesman";
  const isWarehouse = user.role === "warehouse";

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const salesmanId = isSalesman ? user.id : undefined;

    // Shifted-back range for the comparison line, same length as saleRange,
    // ending the instant it starts.
    const rangeMs = new Date(saleRange.to).getTime() - new Date(saleRange.from).getTime();
    const prevTo = new Date(new Date(saleRange.from).getTime() - 24 * 60 * 60 * 1000);
    const prevFrom = new Date(prevTo.getTime() - rangeMs);

    if (isManager) {
      const [s, g, eb, p, w, pk, tr, ptr, pm, sm, lb, oc, ps] = await Promise.all([
        monthToDateSales(supabase),
        monthToDateGrossProfit(supabase),
        fetchExpenseBreakdown(supabase),
        countByStatus(supabase, ["pending"]),
        countByStatus(supabase, ["waiting", "accepted"]),
        countByStatus(supabase, ["packed"]),
        fetchSaleTrend(supabase, { from: new Date(saleRange.from), to: new Date(saleRange.to) }),
        fetchSaleTrend(supabase, { from: prevFrom, to: prevTo }),
        fetchPaymentsByMonthSegmented(supabase),
        fetchSalesByMonth(supabase),
        fetchLeaderboard(supabase),
        countOrdersThisMonth(supabase),
        fetchPaymentsSummary(supabase),
      ]);
      setSales(s);
      setGp(g);
      setExpenseSlices(eb.slices);
      setExpenseTotal(eb.total);
      setPending(p);
      setWaiting(w);
      setPacked(pk);
      setTrend(tr);
      setPrevTrend(ptr);
      setPaymentsByMonth(pm);
      setLeaderboard(lb);
      setOrdersThisMonth(oc);
      setPaySummary(ps);
      fetchMonthlyTargets(supabase).then(setTargets).catch(() => {});
      const prevMonth = sm.length >= 2 ? sm[sm.length - 2].value : 0;
      setPrevSales(prevMonth);
    } else if (isSalesman) {
      const [s, d, w, ap, rj, tr, ptr, pm, sm, ps, lb, oc] = await Promise.all([
        monthToDateSales(supabase, salesmanId),
        countByStatus(supabase, ["draft"], salesmanId),
        countByStatus(supabase, ["pending"], salesmanId),
        countByStatus(supabase, ["approved"], salesmanId),
        countByStatus(supabase, ["rejected"], salesmanId),
        fetchSaleTrend(supabase, { salesmanId, from: new Date(saleRange.from), to: new Date(saleRange.to) }),
        fetchSaleTrend(supabase, { salesmanId, from: prevFrom, to: prevTo }),
        fetchPaymentsByMonthSegmented(supabase, { collectedBy: user.id }),
        fetchSalesByMonth(supabase, { salesmanId }),
        fetchPaymentsSummary(supabase, { salesmanId, collectedBy: user.id }),
        fetchLeaderboard(supabase),
        countOrdersThisMonth(supabase, salesmanId),
      ]);
      setSales(s);
      setDrafts(d);
      setWaiting(w);
      setApproved(ap);
      setRejected(rj);
      setTrend(tr);
      setPrevTrend(ptr);
      setPaymentsByMonth(pm);
      setSalesByMonth(sm);
      setPaySummary(ps);
      setLeaderboard(lb);
      setOrdersThisMonth(oc);
      fetchMonthlyTargets(supabase).then(setTargets).catch(() => {});
      const prevMonth = sm.length >= 2 ? sm[sm.length - 2].value : 0;
      setPrevSales(prevMonth);
    } else if (isWarehouse) {
      const [tp, pa] = await Promise.all([
        countByStatus(supabase, ["waiting", "picking"]),
        countByStatus(supabase, ["packed"]),
      ]);
      setToPick(tp);
      setPackedAwaiting(pa);
    }
    setLoading(false);
  }, [isManager, isSalesman, isWarehouse, user.id, saleRange]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeTable("orders", () => load());
  useRealtimeTable("payments", () => load());

  const changePct = prevSales > 0 ? (sales - prevSales) / prevSales : null;

  if (loading) {
    return (
      <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
        <div className="h-8 w-40 skeleton rounded-card mb-6" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 skeleton rounded-card" />
          ))}
        </div>
      </div>
    );
  }

  // This user's own goal, used by the Target bar on the salesman dashboard.
  const myTarget = targets ? targets.forUser(user.id) : FALLBACK_MONTHLY_TARGET;

  const managerWidgets: Record<(typeof MANAGER_WIDGETS)[number], ReactNode> = {
    stats: (
      <>
        {/* Phone: one packed 4-across strip (Sale · Orders · GP · Profit),
            exactly as the iPhone mockup draws it — four stacked full-width
            cards pushed everything else below the fold. */}
        <Card
          className="lg:hidden p-3 grid grid-cols-4 gap-2 cursor-pointer"
          onClick={() => router.push("/sales")}
        >
          <CompactStat label="Sale" value={formatCompact(sales)} />
          <CompactStat label="Orders" value={String(ordersThisMonth)} />
          <CompactStat label="GP" value={sales > 0 ? `${Math.round((gp / sales) * 100)}%` : "—"} />
          <CompactStat label="Profit" value={formatCompact(gp - expenseTotal)} />
        </Card>
        <div className="hidden lg:grid grid-cols-4 gap-4">
          <StatTile
            label="Sales (month to date)"
            value={formatMoney(sales)}
            numeric={sales}
            format={formatMoney}
            sub={changePct !== null ? undefined : "vs last month n/a"}
            onClick={() => router.push("/sales")}
          />
          <StatTile label="Gross profit" value={formatMoney(gp)} numeric={gp} format={formatMoney} onClick={() => router.push("/sales")} />
          <StatTile
            label="Profit"
            value={formatMoney(gp - expenseTotal)}
            numeric={gp - expenseTotal}
            format={formatMoney}
            onClick={() => router.push("/sales")}
          />
          <StatTile
            label="Orders this month"
            value={String(ordersThisMonth)}
            numeric={ordersThisMonth}
            format={(n) => String(Math.round(n))}
            onClick={() => router.push("/orders")}
          />
        </div>
      </>
    ),
    pipeline: (
      <StatusPipeline
        onClick={() => router.push("/orders")}
        rows={[
          { label: "Pending", value: String(pending), tone: "warning" },
          { label: "Waiting", value: String(waiting), tone: "info" },
          { label: "Packed", value: String(packed), tone: "accent" },
        ]}
      />
    ),
    avgSale: (
      <ExpandableWidget
        title="Average sale"
        expanded={
          <SaleExpanded
            trend={trend}
            prevTrend={prevTrend}
            saleRange={saleRange}
            onChangeRange={changeSaleRange}
            totalSale={sales}
            avgSale={trend.length ? trend.reduce((s, t) => s + t.value, 0) / trend.length : 0}
            totalGp={gp}
            totalProfit={gp - expenseTotal}
            leaderboard={leaderboard}
            onNavigateSales={() => router.push("/sales")}
          />
        }
      >
        <Card className="p-4 h-full flex flex-col">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap shrink-0">
            <span className="text-title font-bold">Average sale</span>
            <div className="flex items-center gap-2">
              {changePct !== null && <ChangeBadge pct={changePct} />}
              <DateRangePicker range={saleRange} onChange={changeSaleRange} />
            </div>
          </div>
          {/* Sized to fill the standard widget height. Previously a 180px
              chart sat in a 336px card, leaving a band of dead space that
              made the widget look broken rather than uniform. */}
          <TrendLineChart values={trend.map((t) => t.value)} height={248} showAverage />
        </Card>
      </ExpandableWidget>
    ),
    payments: (
      <ExpandableWidget
        title="Payments"
        expanded={
          <PaymentsExpanded
            paymentsByMonth={paymentsByMonth}
            summary={paySummary}
            onNavigatePayments={() => router.push("/payments")}
          />
        }
      >
        <Card className="p-4 h-full flex flex-col">
          <div className="text-title font-bold mb-3 shrink-0">Payments</div>
          <MonthlyBarChart
            height={172}
            bars={paymentsByMonth.map((m) => ({
              label: m.label,
              segments: [
                { value: m.cleared, color: "var(--accent)" },
                { value: m.other, color: "#8e8e93" },
                { value: m.bounced, color: "var(--status-danger)" },
              ],
            }))}
          />
          {/* Three narrow columns can't hold "AED 2,827.80" at phone width —
              one figure would wrap to two lines while its neighbours stayed
              on one, leaving the row ragged. The currency moves to the label
              and the figures stay on a single line, so the three always
              share a baseline. */}
          <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-hairline">
            <div className="min-w-0">
              <div className="text-caption text-secondary truncate">Collected (AED)</div>
              <div className="text-subhead font-bold tabular-nums text-accent whitespace-nowrap">
                {paySummary.received.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-caption text-secondary truncate">Remaining (AED)</div>
              <div className="text-subhead font-bold tabular-nums text-secondary whitespace-nowrap">
                {paySummary.remaining.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-caption text-secondary truncate">Overdue (AED)</div>
              <div className="text-subhead font-bold tabular-nums text-[--status-danger] whitespace-nowrap">
                {paySummary.overdue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>
          </div>
        </Card>
      </ExpandableWidget>
    ),
    expense: (
      <ExpandableWidget
        title="Expense breakdown"
        expanded={
          <ExpenseExpanded
            slices={expenseSlices}
            total={expenseTotal}
            onNavigateExpense={() => router.push("/expense")}
          />
        }
      >
        <Card className="p-4 h-full flex flex-col">
          <div className="text-title font-bold mb-3 shrink-0">Expense</div>
          <div className="flex-1 min-h-0 flex items-center">
            <DonutChart
              slices={expenseSlices}
              total={expenseTotal}
              size={196}
              centerLabel={formatCompact(expenseTotal)}
            />
          </div>
        </Card>
      </ExpandableWidget>
    ),
    leaderboard: (
      <ExpandableWidget
        title="Salesman leaderboard"
        expanded={<GoalTableExpanded entries={leaderboard} targets={targets} onOpenSalesman={setDrilldownSalesman} />}
      >
        <LeaderboardStrip entries={leaderboard} />
      </ExpandableWidget>
    ),
    categorySales: <CategorySalesWidget />,
  };

  const salesmanWidgets: Record<(typeof SALESMAN_WIDGETS)[number], ReactNode> = {
    stats: (
      <div className="grid grid-cols-2 gap-4">
        <Card
          className="p-4 cursor-pointer hover:brightness-95 dark:hover:brightness-125 transition"
          onClick={() => router.push("/sales")}
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-caption text-secondary">Sales (month to date)</span>
            {changePct !== null && <ChangeBadge pct={changePct} />}
          </div>
          <div className="text-title font-bold tabular-nums">{formatMoney(sales)}</div>
        </Card>
        <StatTile label="Orders this month" value={String(ordersThisMonth)} onClick={() => router.push("/orders")} />
      </div>
    ),
    newOrder: (
      <Button
        tier="primary"
        onClick={() => setShowNew(true)}
        className="flex items-center justify-center gap-1.5 text-headline font-bold py-3.5"
      >
        <Plus size={18} /> New order
      </Button>
    ),
    pipeline: (
      <StatusPipeline
        onClick={() => router.push("/orders")}
        rows={[
          { label: "Draft", value: String(drafts), tone: "neutral" },
          { label: "Waiting", value: String(waiting), tone: "info" },
          { label: "Approved", value: String(approved), tone: "accent" },
        ]}
      />
    ),
    payments3: (
      <div className="flex flex-col gap-2">
        <StatusPipeline
          onClick={() => router.push("/payments")}
          rows={[
            { label: "Pending", value: String(paySummary.pendingCount), tone: "warning" },
            { label: "Received", value: formatAed(paySummary.received), tone: "accent" },
            { label: "Overdue", value: formatAed(paySummary.overdue), tone: paySummary.overdue > 0 ? "danger" : "neutral" },
          ]}
        />
        {rejected > 0 && <StatTile label="Rejected" value={String(rejected)} sub="Resubmit before they're purged" tone="danger" />}
      </div>
    ),
    target: <TargetBar sale={sales} target={myTarget} />,
    trend: (
      <ExpandableWidget
        title="Sale trend"
        expanded={
          <SaleExpanded
            trend={trend}
            prevTrend={prevTrend}
            saleRange={saleRange}
            onChangeRange={changeSaleRange}
            totalSale={sales}
            avgSale={trend.length ? trend.reduce((s, t) => s + t.value, 0) / trend.length : 0}
            totalGp={0}
            totalProfit={0}
            leaderboard={[]}
            onNavigateSales={() => router.push("/sales")}
          />
        }
      >
        <Card className="p-4">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <span className="text-title font-bold">Sale trend</span>
            <DateRangePicker range={saleRange} onChange={changeSaleRange} />
          </div>
          <TrendLineChart values={trend.map((t) => t.value)} height={180} showAverage />
        </Card>
      </ExpandableWidget>
    ),
    monthly: (
      <ExpandableWidget
        title="Payments & year comparison"
        expanded={
          <div className="flex flex-col gap-4">
            <PaymentsExpanded
              paymentsByMonth={paymentsByMonth}
              summary={paySummary}
              onNavigatePayments={() => router.push("/payments")}
            />
            <Card className="p-4">
              <div className="text-title font-bold mb-3">Sale · year comparison</div>
              <MonthlyBarChart bars={salesByMonth.map((m) => ({ label: m.label, segments: [{ value: m.value }] }))} />
            </Card>
          </div>
        }
      >
        <div className="grid lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="text-title font-bold mb-3">Payments</div>
            <MonthlyBarChart
              bars={paymentsByMonth.map((m) => ({
                label: m.label,
                segments: [
                  { value: m.cleared, color: "var(--accent)" },
                  { value: m.other, color: "#8e8e93" },
                  { value: m.bounced, color: "var(--status-danger)" },
                ],
              }))}
            />
          </Card>
          <Card className="p-4">
            <div className="text-title font-bold mb-3">Sale · year comparison</div>
            <MonthlyBarChart bars={salesByMonth.map((m) => ({ label: m.label, segments: [{ value: m.value }] }))} />
          </Card>
        </div>
      </ExpandableWidget>
    ),
    leaderboard: (
      <ExpandableWidget
        title="Salesman leaderboard"
        expanded={<GoalTableExpanded entries={leaderboard} targets={targets} onOpenSalesman={setDrilldownSalesman} />}
      >
        <LeaderboardStrip entries={leaderboard} youId={user.id} />
      </ExpandableWidget>
    ),
  };

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3">
        {/* §desktop mockup: the dashboard is headed by a greeting and the
            signed-in role, not the word "Dashboard". */}
        <div className="min-w-0">
          <h1 className="text-large-title font-bold truncate">
            Hello, {user.full_name?.split(" ")[0] || user.username}
          </h1>
          <div className="text-caption text-secondary capitalize">{user.role}</div>
        </div>
        {/* Arrange lives at the foot of the page — see PageFooterActions
            below. While you are actually arranging, a Done button belongs
            up here where your eye already is. */}
        {isManager && arranging && (
          <Button tier="primary" onClick={() => setArranging(false)} className="!px-4 !py-1.5 text-caption">
            Done
          </Button>
        )}
      </div>

      {isManager && (
        <ArrangeGrid
          order={managerOrder}
          hidden={hiddenManagerWidgets}
          sizes={managerSizes}
          labels={
            Object.fromEntries([
              ...Object.entries(MANAGER_WIDGET_LABELS),
              ...[...CATALOG_BY_KEY.values()].map((w) => [w.key, w.label]),
            ]) as Record<string, string>
          }
          render={(key) =>
            isCatalogKey(key)
              ? CATALOG_BY_KEY.get(key)?.render()
              : managerWidgets[key as (typeof MANAGER_WIDGETS)[number]]
          }
          // insertAt comes from dragging the widget onto a specific spot; a
          // plain click has no position and appends.
          onAddFromCatalog={(key, insertAt) => {
            const next = [...managerOrder];
            next.splice(insertAt ?? next.length, 0, key as (typeof managerOrder)[number]);
            updatePrefs({ dashboardLayout: next });
          }}
          autoHeightKeys={["stats", "pipeline"]}
          editing={arranging}
          onDoneEditing={() => setArranging(false)}
          onReorder={(next) => updatePrefs({ dashboardLayout: next })}
          onToggleHidden={(key, insertAt) => {
            const wasHidden = hiddenManagerWidgets.includes(key);
            const patch: Record<string, unknown> = {
              dashboardHidden: wasHidden
                ? hiddenManagerWidgets.filter((k) => k !== key)
                : [...hiddenManagerWidgets, key],
            };
            // Bringing one back by dragging it to a spot also moves it there,
            // rather than dropping it wherever it happened to sit before.
            if (wasHidden && insertAt !== undefined) {
              const next = managerOrder.filter((k) => k !== key);
              next.splice(insertAt, 0, key);
              patch.dashboardLayout = next;
            }
            updatePrefs(patch);
          }}
          onChangeSize={(key, size) =>
            updatePrefs({ dashboardSizes: { ...(preferences.dashboardSizes ?? {}), [key]: size } })
          }
        />
      )}

      {isSalesman && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {salesmanOrder.map((key) => (
            <motion.div
              key={key}
              layout
              transition={springLayout}
              className={SALESMAN_WIDGET_FULL[key] ? "lg:col-span-2" : ""}
            >
              {salesmanWidgets[key]}
            </motion.div>
          ))}
        </div>
      )}

      {isWarehouse && (
        <StatusPipeline
          rows={[
            { label: "Orders to pick", value: String(toPick), tone: "warning" },
            { label: "Packed, awaiting approval", value: String(packedAwaiting), tone: "accent" },
          ]}
        />
      )}

      {!arranging && (
        <PageFooterActions
          note={
            isManager
              ? "Drag widgets to reorder them, resize them, or take them off the page."
              : undefined
          }
        >
          {isManager && (
            <Button tier="plain" onClick={() => setArranging(true)} className="!px-3 !py-1.5 text-caption">
              Arrange widgets
            </Button>
          )}
          {isSalesman && (
            <WidgetAdjustPopover
              order={salesmanOrder}
              labels={SALESMAN_WIDGET_LABELS}
              onChange={(next) => updatePrefs({ dashboardLayout: next })}
            />
          )}
        </PageFooterActions>
      )}

      {showNew && (
        <NewOrderSheet
          user={user}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}

      {drilldownSalesman && (
        <SalesmanDrilldown
          entry={drilldownSalesman}
          rank={
            [...leaderboard].sort((a, b) => b.total - a.total).findIndex((e) => e.salesmanId === drilldownSalesman.salesmanId) + 1
          }
          onClose={() => setDrilldownSalesman(null)}
        />
      )}
    </div>
  );
}
