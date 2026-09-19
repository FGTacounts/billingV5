"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchSaleTrend,
  monthToDateSales,
  countOrdersThisMonth,
  type DailyPoint,
} from "@/lib/queries/dashboard";
import { fetchBalanceSheet, type BalanceSheet } from "@/lib/queries/reports";
import { fetchLeaderboard } from "@/lib/queries/sales";
import { fetchMonthlyTargets, teamTarget, FALLBACK_MONTHLY_TARGET } from "@/lib/queries/targets";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { TrendLineChart, MonthlyBarChart } from "@/components/ui/charts";
import { ArrangeGrid } from "@/components/ui/ArrangeGrid";
import { resolveOrder, type WidgetSize } from "@/components/ui/WidgetArrange";
import { CATALOG_BY_KEY } from "@/components/widgets/catalog";
import { usePreferences } from "@/lib/hooks/usePreferences";

// The iOS Reports tab carries a second surface above its tables: an
// arrangeable board of sales widgets (ReportLayoutStore.swift — monthly
// average, target progress, month summary, weekly report, GP calculation,
// sales by category, with the first four on by default). This is that board
// for the web, on the same Full/Half/Quarter grid every other arrangeable
// page uses. The financial tables below it are untouched.
//
// Every figure here comes from the query layer that already owns it —
// fetchSaleTrend / monthToDateSales / countOrdersThisMonth for the sales
// numbers, fetchMonthlyTargets for the goal, fetchBalanceSheet (the same
// call behind the Balance Sheet tab on this page) for sales-ex-VAT and
// COGS, and the shared catalogue widget for the category split. Nothing
// here recomputes a number that already has a home.

const REPORT_WIDGETS = [
  "monthlyAverage",
  "targetProgress",
  "monthSummary",
  "weeklyReport",
  "gpCalculation",
  "categoryBreakdown",
] as const;
type ReportWidgetKey = (typeof REPORT_WIDGETS)[number];

const REPORT_WIDGET_LABELS: Record<ReportWidgetKey, string> = {
  monthlyAverage: t("reports.widgetMonthlyAverage"),
  targetProgress: t("reports.widgetTargetProgress"),
  monthSummary: t("reports.widgetMonthSummary"),
  weeklyReport: t("reports.widgetWeeklyReport"),
  gpCalculation: t("reports.widgetGpCalculation"),
  categoryBreakdown: t("reports.widgetSalesByCategory"),
};

// Matches ReportWidget.defaultSet on iOS: weekly report and the category
// split are opt-in, so they start life in the widget gallery.
const DEFAULT_HIDDEN: ReportWidgetKey[] = ["weeklyReport", "categoryBreakdown"];

const WEEKDAYS = [
  t("reports.weekdaySun"),
  t("reports.weekdayMon"),
  t("reports.weekdayTue"),
  t("reports.weekdayWed"),
  t("reports.weekdayThu"),
  t("reports.weekdayFri"),
  t("reports.weekdaySat"),
];
const MONTHS_SHORT = [
  t("reports.monthJan"),
  t("reports.monthFeb"),
  t("reports.monthMar"),
  t("reports.monthApr"),
  t("reports.monthMay"),
  t("reports.monthJun"),
  t("reports.monthJul"),
  t("reports.monthAug"),
  t("reports.monthSep"),
  t("reports.monthOct"),
  t("reports.monthNov"),
  t("reports.monthDec"),
];

interface BoardData {
  monthTrend: DailyPoint[];
  weekTrend: DailyPoint[];
  monthSales: number;
  orderCount: number;
  target: number;
  balance: BalanceSheet | null;
}

/** A label over a figure. Every figure is tabular so columns line up. */
function Stat({ label, value, tone }: { label: string; value: string; tone?: "accent" | "warning" | "danger" }) {
  const toneClass =
    tone === "accent"
      ? "text-accent"
      : tone === "warning"
        ? "text-[--status-warning]"
        : tone === "danger"
          ? "text-[--status-danger]"
          : "";
  return (
    <div className="flex-1 min-w-0 rounded-inner bg-canvas px-3 py-2.5">
      <div className="text-caption text-secondary truncate">{label}</div>
      <div className={`text-headline font-semibold mt-0.5 tabular-nums truncate ${toneClass}`}>{value}</div>
    </div>
  );
}

function WidgetShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="p-4 h-full flex flex-col">
      <div className="text-caption text-secondary font-semibold uppercase tracking-wide shrink-0">{title}</div>
      <div className="flex-1 min-h-0 flex flex-col justify-center gap-2.5 mt-3">{children}</div>
    </Card>
  );
}

function SkeletonRows({ n = 3 }: { n?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="h-9 skeleton rounded-inner" />
      ))}
    </div>
  );
}

export default function ReportsBoard() {
  const { preferences, update: updatePrefs } = usePreferences();
  const [arranging, setArranging] = useState(false);
  const [data, setData] = useState<BoardData | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [monthTrend, weekTrend, monthSales, orderCount, leaderboard, targets, balance] = await Promise.all([
      fetchSaleTrend(supabase, { from: monthStart, to: now }),
      fetchSaleTrend(supabase, { days: 7 }),
      monthToDateSales(supabase),
      countOrdersThisMonth(supabase),
      fetchLeaderboard(supabase),
      fetchMonthlyTargets(supabase),
      // The GP figures are the Balance Sheet tab's own, so the two can never
      // disagree on this page.
      fetchBalanceSheet(supabase).catch(() => null),
    ]);

    // Same rule the Sales page uses: the team's goal is the rostered
    // salesmen's goals added up, so a manager covering a route doesn't
    // inflate it.
    const rostered = leaderboard
      .filter((e) => e.role === undefined || e.role === "salesman")
      .map((e) => e.salesmanId);
    const target = teamTarget(targets, rostered) || targets.fallback || FALLBACK_MONTHLY_TARGET;

    setData({ monthTrend, weekTrend, monthSales, orderCount, target, balance });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const order = useMemo(
    () => resolveOrder(REPORT_WIDGETS, preferences.reportsLayout),
    [preferences.reportsLayout]
  );

  const hidden = useMemo<ReportWidgetKey[]>(
    () =>
      ((preferences.reportsHidden as string[] | undefined) ?? (DEFAULT_HIDDEN as string[])).filter(
        (k): k is ReportWidgetKey => (REPORT_WIDGETS as readonly string[]).includes(k)
      ),
    [preferences.reportsHidden]
  );

  const sizes = useMemo(() => {
    const stored = (preferences.reportsSizes ?? {}) as Record<string, WidgetSize>;
    const out = {} as Record<ReportWidgetKey, WidgetSize>;
    for (const k of REPORT_WIDGETS) out[k] = stored[k] ?? "half";
    return out;
  }, [preferences.reportsSizes]);

  // --- the six widgets ----------------------------------------------------

  const monthLabel = useMemo(() => {
    const now = new Date();
    return t("reports.monthYear", { month: MONTHS_SHORT[now.getMonth()], year: now.getFullYear() });
  }, []);

  const dailyAverage = useMemo(() => {
    if (!data || data.monthTrend.length === 0) return 0;
    return data.monthSales / data.monthTrend.length;
  }, [data]);

  const bestDay = useMemo(() => {
    if (!data || data.monthTrend.length === 0) return null;
    let bestIndex = 0;
    data.monthTrend.forEach((p, i) => {
      if (p.value > data.monthTrend[bestIndex].value) bestIndex = i;
    });
    const best = data.monthTrend[bestIndex];
    if (best.value <= 0) return null;
    const now = new Date();
    const date = new Date(now.getFullYear(), now.getMonth(), bestIndex + 1);
    return { label: t("reports.dayMonth", { day: date.getDate(), month: MONTHS_SHORT[date.getMonth()] }), value: best.value };
  }, [data]);

  // fetchSaleTrend labels points by day-of-month; the weekly card wants
  // weekday names, and the window is a fixed "the last 7 days ending today".
  const weekBars = useMemo(() => {
    if (!data) return [];
    const today = new Date();
    return data.weekTrend.map((p, i) => {
      const d = new Date(today);
      d.setDate(d.getDate() - (data.weekTrend.length - 1 - i));
      return { label: WEEKDAYS[d.getDay()], segments: [{ value: p.value, color: "var(--accent)" }] };
    });
  }, [data]);

  const weekTotal = useMemo(
    () => (data ? data.weekTrend.reduce((s, p) => s + p.value, 0) : 0),
    [data]
  );

  const widgets: Record<ReportWidgetKey, ReactNode> = {
    monthlyAverage: (
      <WidgetShell title={t("reports.monthlyAverageOf", { month: monthLabel })}>
        {!data ? (
          <SkeletonRows />
        ) : (
          <>
            <div className="flex gap-2.5">
              <Stat label={t("reports.totalSales")} value={formatAed(data.monthSales)} />
              <Stat label={t("reports.averagePerDay")} value={formatAed(dailyAverage)} tone="accent" />
            </div>
            <TrendLineChart values={data.monthTrend.map((p) => p.value)} height={150} showAverage />
          </>
        )}
      </WidgetShell>
    ),

    targetProgress: (() => {
      const achieved = data?.monthSales ?? 0;
      const target = data?.target ?? 0;
      const remaining = Math.max(0, target - achieved);
      const pct = target > 0 ? Math.min(100, (achieved / target) * 100) : 0;
      return (
        <WidgetShell title={t("reports.teamTarget")}>
          {!data ? (
            <SkeletonRows />
          ) : (
            <>
              <div className="flex gap-2.5">
                <Stat label={t("sales.target")} value={formatAed(target)} />
                <Stat label={t("reports.achieved")} value={formatAed(achieved)} />
                <Stat
                  label={t("dashboard.remaining")}
                  value={remaining === 0 ? t("common.done") : formatAed(remaining)}
                  tone={remaining === 0 ? "accent" : "warning"}
                />
              </div>
              <div
                className="h-2 rounded-full bg-canvas overflow-hidden"
                role="progressbar"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={t("reports.progressAria")}
              >
                <div
                  className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out motion-reduce:transition-none"
                  style={{ inlineSize: `${pct}%` }}
                />
              </div>
              <p className="text-caption text-secondary">
                {remaining === 0
                  ? t("reports.targetReached")
                  : t("reports.amountLeftToTarget", { amount: formatAed(remaining) })}
              </p>
            </>
          )}
        </WidgetShell>
      );
    })(),

    monthSummary: (
      <WidgetShell title={t("reports.monthSummary")}>
        {!data ? (
          <SkeletonRows />
        ) : (
          <>
            <div className="flex gap-2.5">
              <Stat label={t("reports.totalSales")} value={formatAed(data.monthSales)} />
              <Stat label={t("nav.orders")} value={String(data.orderCount)} />
            </div>
            <div className="flex gap-2.5">
              <Stat label={t("reports.bestDay")} value={bestDay ? bestDay.label : t("common.notSet")} />
              <Stat label={t("reports.bestDaySales")} value={bestDay ? formatAed(bestDay.value) : t("common.notSet")} />
            </div>
          </>
        )}
      </WidgetShell>
    ),

    weeklyReport: (
      <WidgetShell title={t("reports.last7Days")}>
        {!data ? (
          <SkeletonRows />
        ) : (
          <>
            <div className="flex gap-2.5">
              <Stat label={t("common.total")} value={formatAed(weekTotal)} />
              <Stat label={t("reports.dailyAverage")} value={formatAed(weekTotal / 7)} tone="accent" />
            </div>
            <MonthlyBarChart bars={weekBars} height={110} />
          </>
        )}
      </WidgetShell>
    ),

    gpCalculation: (() => {
      const b = data?.balance ?? null;
      const gp = b ? b.monthlySales - b.cogs : 0;
      const margin = b && b.monthlySales > 0 ? (gp / b.monthlySales) * 100 : 0;
      return (
        <WidgetShell title={t("reports.gpCalculation")}>
          {!data ? (
            <SkeletonRows />
          ) : !b ? (
            <p className="text-caption text-secondary">{t("reports.costFiguresUnavailable")}</p>
          ) : (
            <>
              <div className="flex gap-2.5">
                <Stat label={t("reports.salesExVat")} value={formatAed(b.monthlySales)} />
                <Stat label={t("reports.cost")} value={formatAed(b.cogs)} />
              </div>
              <div className="flex gap-2.5">
                <Stat label={t("sales.grossProfit")} value={formatAed(gp)} tone={gp >= 0 ? "accent" : "danger"} />
                <Stat
                  label={t("reports.margin")}
                  value={`${margin.toFixed(1)}%`}
                  tone={margin >= 0 ? "accent" : "danger"}
                />
              </div>
            </>
          )}
        </WidgetShell>
      );
    })(),

    // The category split already exists as a shared catalogue widget, fed by
    // fetchSalesByCategory — reused whole rather than rebuilt here.
    categoryBreakdown: CATALOG_BY_KEY.get("cat:salesByCategory")?.render() ?? null,
  };

  return (
    <section className="mb-6" aria-label={t("reports.salesWidgets")}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-title font-bold">{t("reports.salesWidgets")}</h2>
        <Button
          tier={arranging ? "primary" : "plain"}
          onClick={() => setArranging((v) => !v)}
          className="flex items-center gap-1.5 min-h-[44px] min-w-[44px] !py-2"
        >
          <SlidersHorizontal size={15} />
          {arranging ? t("common.done") : t("reports.arrange")}
        </Button>
      </div>

      <ArrangeGrid<ReportWidgetKey>
        order={order}
        hidden={hidden}
        sizes={sizes}
        labels={REPORT_WIDGET_LABELS}
        render={(key) => widgets[key]}
        editing={arranging}
        onDoneEditing={() => setArranging(false)}
        onReorder={(next) => updatePrefs({ reportsLayout: next })}
        onToggleHidden={(key, insertAt) => {
          const wasHidden = hidden.includes(key);
          const patch: Record<string, unknown> = {
            reportsHidden: wasHidden ? hidden.filter((k) => k !== key) : [...hidden, key],
          };
          // Dragging one back out of the gallery drops it where you let go,
          // rather than wherever it happened to sit before.
          if (wasHidden && insertAt !== undefined) {
            const next = order.filter((k) => k !== key);
            next.splice(insertAt, 0, key);
            patch.reportsLayout = next;
          }
          updatePrefs(patch);
        }}
        onChangeSize={(key, size) =>
          updatePrefs({ reportsSizes: { ...(preferences.reportsSizes ?? {}), [key]: size } })
        }
      />
    </section>
  );
}
