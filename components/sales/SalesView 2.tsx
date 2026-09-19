"use client";

import { useEffect, useState, useCallback, useMemo, type ReactNode } from "react";
import { springLayout } from "@/lib/motion";
import { motion } from "framer-motion";
import { Trophy, TrendingUp, TrendingDown, ArrowUpDown } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/queries/sales";
import {
  monthToDateSales,
  monthToDateGrossProfit,
  fetchSaleTrend,
  fetchSalesByMonth,
  countOrdersInRange,
  paymentsReceivedInRange,
  salesOnDay,
  type DailyPoint,
} from "@/lib/queries/dashboard";
import { fetchMonthlyTargets, saveIncentive, teamTarget, FALLBACK_MONTHLY_TARGET, type MonthlyTargets } from "@/lib/queries/targets";
import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/errors";
import type { AppUser } from "@/lib/types/db";
import { formatAed, formatCompact } from "@/lib/money";
import { SkeletonList, EmptyState } from "@/components/ui/Empty";
import { Card } from "@/components/ui/Card";
import { TrendLineChart } from "@/components/ui/charts";
import { DateRangePicker, presetToRange, rangeLabel, type SaleRange } from "@/components/ui/DateRangePicker";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { WidgetAdjustPopover, resolveOrder, SIZE_SPAN, type WidgetSize } from "@/components/ui/WidgetArrange";
import { SalesmanDrilldown } from "@/components/sales/SalesmanDrilldown";
import { WidgetContextMenu } from "@/components/ui/WidgetContextMenu";

const MEDAL = ["#FFD700", "#C0C0C0", "#CD7F32"];

// Arrange (§Next Updates Sales: "unify split-widget sizes with an Arrange
// section") — same Full/Half pattern as the Dashboard. "gp" is Manager-only
// and filtered out of the canonical order for other roles.
const SALES_WIDGETS = ["stats", "trend", "goal", "gp", "ordersPayments", "monthlyDetail"] as const;
type SalesWidgetKey = (typeof SALES_WIDGETS)[number];
const SALES_WIDGET_LABELS: Record<SalesWidgetKey, string> = {
  stats: t("sales.widgetStats"),
  trend: t("sales.widgetTrend"),
  goal: t("sales.widgetGoal"),
  gp: t("sales.grossProfit"),
  ordersPayments: t("sales.ordersAndPayments"),
  monthlyDetail: t("sales.widgetMonthlyDetail"),
};
const SALES_WIDGET_FULL: Record<SalesWidgetKey, boolean> = {
  stats: true,
  trend: false,
  goal: false,
  gp: false,
  ordersPayments: false,
  monthlyDetail: true,
};

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <div className="text-caption text-secondary truncate">{label}</div>
      <div className="text-title font-bold mt-1 tabular-nums">{value}</div>
    </Card>
  );
}

function ChangeBadge({ label, pct }: { label: string; pct: number | null }) {
  if (pct === null) return null;
  const up = pct >= 0;
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-caption font-semibold px-1.5 py-0.5 rounded-full ${
        up ? "bg-accent/12 text-accent" : "bg-danger/12 text-[--status-danger]"
      }`}
    >
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {label} {Math.abs(Math.round(pct * 100))}%
    </span>
  );
}

type GoalSort = "rank" | "name" | "pct";

export default function SalesView({ user }: { user: AppUser }) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [goalSort, setGoalSort] = useState<GoalSort>("rank");
  const [widgetRange, setWidgetRange] = useState<SaleRange>(() => presetToRange(30));
  const [drilldownSalesman, setDrilldownSalesman] = useState<LeaderboardEntry | null>(null);
  // Monthly Detail's own salesman picker (§Sales: "no need for the whole
  // page to be scoped to one salesman via the filter dropdown" — but "the
  // Monthly Detail widget should be sortable by salesman") — scoped only to
  // that one widget, independent of everything else on the page.
  const [monthlyFilter, setMonthlyFilter] = useState<string>("team");
  const { preferences, update: updatePrefs } = usePreferences();

  const [totalSale, setTotalSale] = useState(0);
  const [totalGp, setTotalGp] = useState(0);
  const [trend, setTrend] = useState<DailyPoint[]>([]);
  const [monthly, setMonthly] = useState<{ label: string; sale: number; pastYear: number }[]>([]);
  const [ordersInRange, setOrdersInRange] = useState(0);
  const [paymentsInRange, setPaymentsInRange] = useState(0);
  // Day-level trend comparisons (§Next Updates: "same day last month AND
  // same day last year") — separate from the month-level MoM/YoY badges
  // below, which compare whole-month totals, not a single day.
  const [todaySale, setTodaySale] = useState(0);
  const [sameDayLastMonth, setSameDayLastMonth] = useState(0);
  const [sameDayLastYear, setSameDayLastYear] = useState(0);
  // Goals come from the database now — per salesman, falling back to the
  // company-wide figure for anyone without one of their own.
  const [targets, setTargets] = useState<MonthlyTargets | null>(null);
  // Goals are only editable where the column exists (it arrives with the
  // sales-targets migration); without it the field would refuse every save.
  const [targetsEditable, setTargetsEditable] = useState(false);

  const isManager = (user.role === "manager" || user.role === "admin");
  // A Manager always sees whole-team numbers on this page now; a Salesman
  // still only ever sees their own (unrelated to the removed page-wide
  // filter — this is the existing per-role visibility rule).
  const scopedSalesmanId = isManager ? undefined : user.id;
  const monthlyScopedId = monthlyFilter === "team" ? undefined : monthlyFilter;

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const from = new Date(widgetRange.from);
    const to = new Date(widgetRange.to);
    const today = new Date();
    const dayLastMonth = new Date(today);
    dayLastMonth.setMonth(dayLastMonth.getMonth() - 1);
    const dayLastYear = new Date(today);
    dayLastYear.setFullYear(dayLastYear.getFullYear() - 1);

    const [lb, sale, gp, tr, oc, pr, todayS, lastMonthS, lastYearS, tgts] = await Promise.all([
      fetchLeaderboard(supabase),
      monthToDateSales(supabase, scopedSalesmanId),
      isManager ? monthToDateGrossProfit(supabase, scopedSalesmanId) : Promise.resolve(0),
      fetchSaleTrend(supabase, { salesmanId: scopedSalesmanId }),
      countOrdersInRange(supabase, { from, to, salesmanId: scopedSalesmanId }),
      paymentsReceivedInRange(supabase, { from, to, collectedBy: isManager ? undefined : user.id }),
      salesOnDay(supabase, today, scopedSalesmanId),
      salesOnDay(supabase, dayLastMonth, scopedSalesmanId),
      salesOnDay(supabase, dayLastYear, scopedSalesmanId),
      fetchMonthlyTargets(supabase),
    ]);
    setTargets(tgts);
    setEntries(lb);
    if (isManager) {
      const probe = await supabase.from("users").select("monthly_target").limit(1);
      setTargetsEditable(!probe.error);
    }
    setTotalSale(sale);
    setTotalGp(gp);
    setTrend(tr);
    setOrdersInRange(oc);
    setPaymentsInRange(pr);
    setTodaySale(todayS);
    setSameDayLastMonth(lastMonthS);
    setSameDayLastYear(lastYearS);
    setLoading(false);
  }, [scopedSalesmanId, isManager, widgetRange, user.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Monthly Detail fetches independently of the rest of the page, scoped by
  // its own widget-local salesman picker.
  useEffect(() => {
    const monthlyScopedForRole = isManager ? monthlyScopedId : user.id;
    const supabase = supabaseBrowser();
    Promise.all([
      fetchSalesByMonth(supabase, { salesmanId: monthlyScopedForRole }),
      fetchSalesByMonth(supabase, { salesmanId: monthlyScopedForRole, yearsAgo: 1 }),
    ]).then(([thisYear, lastYear]) => {
      setMonthly(thisYear.map((m, i) => ({ label: m.label, sale: m.value, pastYear: lastYear[i]?.value ?? 0 })));
    });
  }, [isManager, monthlyScopedId, user.id]);

  const visible = entries;
  const topSeller = entries[0]?.name ?? "—";
  // A Manager sees progress against the whole team's combined goal; a
  // Salesman against their own.
  const myTarget = targets ? targets.forUser(user.id) : FALLBACK_MONTHLY_TARGET;
  // The team's goal is the salesmen's goals added up. The leaderboard now
  // also carries anyone else who billed (a manager covering a route, say),
  // and giving them a goal of their own would inflate the team's.
  const rosteredIds = useMemo(
    () => entries.filter((e) => e.role === undefined || e.role === "salesman").map((e) => e.salesmanId),
    [entries]
  );
  const combinedTarget = targets
    ? isManager
      ? teamTarget(targets, rosteredIds)
      : myTarget
    : FALLBACK_MONTHLY_TARGET;
  const targetPct = combinedTarget > 0 ? totalSale / combinedTarget : 0;
  // Monthly Detail has its own salesman picker, so its Target column follows
  // that selection rather than the page-level one.
  const monthlyTarget = !targets
    ? FALLBACK_MONTHLY_TARGET
    : monthlyFilter === "team" && isManager
      ? teamTarget(targets, rosteredIds)
      : targets.forUser(isManager ? monthlyFilter : user.id);

  // Sale trend header comparisons (§Sales: "show total sale, with
  // comparison of last month sale percentage and same month from last
  // year's percentage") — derived from the already-fetched monthly series
  // rather than a separate query: last element is the current month.
  const curMonth = monthly[monthly.length - 1];
  const prevMonth = monthly[monthly.length - 2];
  const momPct = curMonth && prevMonth && prevMonth.sale > 0 ? (curMonth.sale - prevMonth.sale) / prevMonth.sale : null;
  const yoyPct = curMonth && curMonth.pastYear > 0 ? (curMonth.sale - curMonth.pastYear) / curMonth.pastYear : null;
  const dayMomPct = sameDayLastMonth > 0 ? (todaySale - sameDayLastMonth) / sameDayLastMonth : null;
  const dayYoyPct = sameDayLastYear > 0 ? (todaySale - sameDayLastYear) / sameDayLastYear : null;

  // §Sales: the manager sets a salesman's monthly goal from here, next to
  // the figure it is measured against, rather than only from Settings.
  async function saveGoal(salesmanId: string, raw: string) {
    const trimmed = raw.trim();
    const target = trimmed === "" ? null : Number(trimmed);
    if (target !== null && (!Number.isFinite(target) || target < 0)) {
      toast.error(t("sales.goalInvalid"));
      return;
    }
    // Ask for the changed row back. A write the database declines to apply
    // reports success and changes nothing, so an empty result is the only
    // way to tell "saved" from "quietly refused".
    const { data: saved, error } = await supabaseBrowser()
      .from("users")
      .update({ monthly_target: target })
      .eq("id", salesmanId)
      .select("id");
    if (error) {
      toast.error(friendlyError(error, t("sales.goalSaveFailed")));
      return;
    }
    if (!saved || saved.length === 0) {
      toast.error(t("sales.goalNoPermission"));
      return;
    }
    toast.success(target === null ? t("sales.goalCleared") : t("sales.goalSaved"));
    load();
  }

  // The bonus and the special offer the manager sets alongside the goal —
  // the two figures the phone has kept per salesman since V5 and could not
  // share with anyone. Set here, beside the goal they hang off.
  async function saveBonus(salesmanId: string, raw: string) {
    const trimmed = raw.trim();
    const bonus = trimmed === "" ? null : Number(trimmed);
    if (bonus !== null && (!Number.isFinite(bonus) || bonus < 0)) {
      toast.error(t("sales.bonusInvalid"));
      return;
    }
    try {
      const applied = await saveIncentive(supabaseBrowser(), salesmanId, { monthly_bonus: bonus });
      if (!applied) {
        toast.error(t("sales.bonusNoPermission"));
        return;
      }
      toast.success(bonus === null ? t("sales.bonusCleared") : t("sales.bonusSaved"));
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("sales.bonusSaveFailed")));
    }
  }

  async function saveOffer(salesmanId: string, raw: string) {
    const note = raw.trim();
    try {
      const applied = await saveIncentive(supabaseBrowser(), salesmanId, {
        incentive_note: note === "" ? null : note,
      });
      if (!applied) {
        toast.error(t("sales.incentiveNoPermission"));
        return;
      }
      toast.success(note === "" ? t("sales.offerCleared") : t("sales.offerSaved"));
      load();
    } catch (e) {
      toast.error(friendlyError(e, t("sales.offerSaveFailed")));
    }
  }

  const goalEntries = useMemo(() => {
    const withPct = visible.map((e, i) => ({
      ...e,
      rank: i,
      target: targets ? targets.forUser(e.salesmanId) : FALLBACK_MONTHLY_TARGET,
      pct: (targets ? targets.forUser(e.salesmanId) : FALLBACK_MONTHLY_TARGET) > 0 ? e.total / (targets ? targets.forUser(e.salesmanId) : FALLBACK_MONTHLY_TARGET) : 0,
    }));
    const sorted = [...withPct];
    if (goalSort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (goalSort === "pct") sorted.sort((a, b) => b.pct - a.pct);
    else sorted.sort((a, b) => a.rank - b.rank);
    return sorted;
  }, [visible, goalSort]);

  const canonicalSalesWidgets = useMemo(
    () => (isManager ? SALES_WIDGETS : SALES_WIDGETS.filter((k) => k !== "gp")),
    [isManager]
  );
  const salesOrder = useMemo(
    () => resolveOrder(canonicalSalesWidgets, preferences.salesLayout),
    [canonicalSalesWidgets, preferences.salesLayout]
  );

  // Same Full/Half/Quarter sizing as the Dashboard (§Sales: "add the
  // standardized widget sizing system to Sales too"), defaulting to each
  // widget's existing width.
  const salesSizes = useMemo(() => {
    const stored = (preferences.salesSizes ?? {}) as Record<string, WidgetSize>;
    const out = {} as Record<SalesWidgetKey, WidgetSize>;
    for (const k of SALES_WIDGETS) out[k] = stored[k] ?? (SALES_WIDGET_FULL[k] ? "full" : "half");
    return out;
  }, [preferences.salesSizes]);

  const salesWidgets: Record<SalesWidgetKey, ReactNode> = {
    stats: (
      <div className={`grid gap-4 ${isManager ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
        <StatTile label={t("sales.totalSale")} value={formatAed(totalSale)} />
        {isManager && <StatTile label={t("sales.totalGp")} value={formatAed(totalGp)} />}
        <StatTile label={t("sales.topSeller")} value={topSeller} />
        <StatTile label={t("sales.pctToTarget")} value={`${Math.min(100, Math.round(targetPct * 100))}%`} />
      </div>
    ),
    trend: (
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <span className="text-title font-bold">{t("sales.sale")}</span>
          {/* §Sales mockup: Total, then the Last Month / Last Year chips. */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-caption text-secondary">{t("common.total")}</span>
            <span className="text-title font-bold tabular-nums text-accent">
              {formatCompact(totalSale)}
            </span>
            <ChangeBadge label={t("sales.lastMonth")} pct={momPct} />
            <ChangeBadge label={t("sales.lastYear")} pct={yoyPct} />
          </div>
        </div>
        <TrendLineChart values={trend.map((t) => t.value)} height={180} showAverage />
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <span className="text-caption text-secondary">{t("sales.todayVsSameDay")}</span>
          <ChangeBadge label={t("sales.lastMonthLower")} pct={dayMomPct} />
          <ChangeBadge label={t("sales.lastYearLower")} pct={dayYoyPct} />
        </div>
      </Card>
    ),
    goal:
      visible.length === 0 ? (
        <EmptyState icon={Trophy} title={t("sales.noSalesYetThisMonth")} />
      ) : (
        <Card className="overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
            <span className="text-title font-bold">{t("sales.goal")}</span>
            <div className="flex items-center gap-1">
              {(["rank", "name", "pct"] as GoalSort[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setGoalSort(s)}
                  className={`flex items-center gap-1 px-2 py-1 rounded-card text-caption font-medium ${
                    goalSort === s ? "bg-accent/12 text-accent" : "text-secondary"
                  }`}
                >
                  {s === "rank" ? <ArrowUpDown size={11} /> : null}
                  {s === "rank" ? t("sales.sortRank") : s === "name" ? t("sales.name") : t("sales.sortPctAchieved")}
                </button>
              ))}
            </div>
          </div>
          <div className="divide-y divide-hairline">
            {goalEntries.map((e) => {
              const isYou = e.salesmanId === user.id;
              const isTop = e.rank === 0;
              const pctLeft = Math.max(0, 1 - e.pct);
              const amountLeft = Math.max(0, e.target - e.total);
              const bonus = targets?.bonusForUser(e.salesmanId) ?? null;
              const offer = targets?.noteForUser(e.salesmanId) ?? "";
              return (
                <div key={e.salesmanId} className={isYou ? "bg-accent/5" : ""}>
                <button
                  onClick={() => setDrilldownSalesman(e)}
                  className="w-full text-left px-4 py-3.5 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] transition"
                >
                  <div className="flex items-center gap-4">
                    <div
                      className="w-8 text-center font-bold tabular-nums shrink-0"
                      style={{ color: MEDAL[e.rank] ?? "var(--text-secondary)", fontSize: isTop ? 20 : 15 }}
                    >
                      {e.rank + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className={`truncate ${isTop ? "text-headline font-bold" : "text-subhead font-medium"}`}>
                        {e.name} {isYou && <span className="text-caption text-accent">{t("sales.you")}</span>}
                        {/* Someone who billed without being on the salesman
                            roster — shown rather than dropped, but named for
                            what they are. */}
                        {e.role && e.role !== "salesman" && (
                          <span className="text-caption text-secondary">{t("sales.roleSuffix", { role: e.role })}</span>
                        )}
                      </div>
                      <div className="h-1.5 rounded-full bg-canvas overflow-hidden mt-1.5 max-w-[140px]">
                        <div
                          className="h-full rounded-full bg-accent"
                          style={{ width: `${Math.min(100, e.pct * 100)}%` }}
                        />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={`tabular-nums font-semibold ${isTop ? "text-headline" : "text-subhead"}`}>
                        {formatAed(e.total)}
                      </div>
                      <div className="text-caption text-secondary tabular-nums">
                        {Math.round(e.pct * 100)}%
                      </div>
                    </div>
                  </div>
                  {/* Expanded (wide-screen) detail: percent left + amount left */}
                  <div className="hidden lg:flex items-center justify-end gap-4 mt-1.5 text-caption text-secondary">
                    <span>{t("sales.pctLeft", { pct: Math.round(pctLeft * 100) })}</span>
                    <span className="tabular-nums">{t("sales.amountLeft", { amount: formatAed(amountLeft) })}</span>
                  </div>
                  {/* What is on offer for hitting the goal. Shown to
                      everyone who can see the row, not only the manager who
                      set it — an incentive nobody is told about is not one. */}
                  {(bonus !== null || offer) && (
                    <div className="flex items-center gap-2 flex-wrap mt-1.5 text-caption">
                      {bonus !== null && (
                        <span className="text-accent font-semibold tabular-nums">
                          {t("sales.bonusAmount", { amount: formatAed(bonus) })}
                        </span>
                      )}
                      {offer && <span className="text-secondary min-w-0 break-words">{offer}</span>}
                    </div>
                  )}
                </button>
                {/* Sits outside the button on purpose — a text field inside
                    one cannot be typed into. */}
                {isManager && targetsEditable && (
                  <label className="flex items-center justify-end gap-2 px-4 pb-3 -mt-1">
                    <span className="text-caption text-secondary">{t("sales.monthlyGoal")}</span>
                    <input
                      type="number"
                      min="0"
                      step="100"
                      defaultValue={targets?.byUser.get(e.salesmanId) ?? ""}
                      placeholder={String(targets?.fallback ?? FALLBACK_MONTHLY_TARGET)}
                      onBlur={(ev) => saveGoal(e.salesmanId, ev.target.value)}
                      onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }}
                      className="w-28 px-3 py-1 rounded-chip border border-hairline bg-canvas text-caption tabular-nums text-right"
                      title={t("sales.goalHint")}
                    />
                  </label>
                )}
                {/* Bonus and special offer, hidden until RUN-ME-20 has been
                    run rather than shown as fields that refuse every save.
                    Outside the button for the same reason the goal is. */}
                {isManager && targets?.bonusSupported && (
                  <div className="flex items-center justify-end gap-2 flex-wrap px-4 pb-3 -mt-1">
                    <label className="flex items-center gap-2">
                      <span className="text-caption text-secondary">{t("sales.bonus")}</span>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        defaultValue={bonus ?? ""}
                        placeholder={t("common.none")}
                        onBlur={(ev) => saveBonus(e.salesmanId, ev.target.value)}
                        onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }}
                        className="w-24 px-3 py-1 rounded-chip border border-hairline bg-canvas text-caption tabular-nums text-right"
                        title={t("sales.bonusHint")}
                      />
                    </label>
                    <label className="flex items-center gap-2 flex-1 min-w-[180px]">
                      <span className="text-caption text-secondary shrink-0">{t("sales.specialOffer")}</span>
                      <input
                        type="text"
                        defaultValue={offer}
                        placeholder={t("sales.offerPlaceholder")}
                        onBlur={(ev) => saveOffer(e.salesmanId, ev.target.value)}
                        onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); }}
                        className="flex-1 min-w-0 px-3 py-1 rounded-chip border border-hairline bg-canvas text-caption"
                        title={t("sales.offerHint")}
                      />
                    </label>
                  </div>
                )}
                </div>
              );
            })}
          </div>
        </Card>
      ),
    gp: (
      <Card className="p-4">
        <div className="text-caption text-secondary mb-1">{t("sales.grossProfit")}</div>
        <div className="text-title font-bold tabular-nums">{formatAed(totalGp)}</div>
        <div className="text-caption text-secondary mt-0.5">
          {totalSale > 0 ? t("sales.pctOfSale", { pct: Math.round((totalGp / totalSale) * 100) }) : t("common.notSet")}
        </div>
      </Card>
    ),
    ordersPayments: (
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
          <span className="text-title font-bold">{t("sales.ordersAndPayments")}</span>
          <DateRangePicker range={widgetRange} onChange={setWidgetRange} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="text-headline font-bold mb-1.5">{t("nav.orders")}</div>
            <div className="rounded-card bg-accent text-white p-4 text-center">
              <div className="text-large-title font-bold tabular-nums">{ordersInRange}</div>
            </div>
          </div>
          <div>
            <div className="text-headline font-bold mb-1.5">{t("nav.payments")}</div>
            <div className="rounded-card bg-accent text-white p-4 text-center">
              <div className="text-large-title font-bold tabular-nums">{formatAed(paymentsInRange)}</div>
            </div>
          </div>
        </div>
      </Card>
    ),
    monthlyDetail: (
      <Card className="p-4 overflow-x-auto">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <div className="text-caption text-secondary">
            {t("sales.monthlyDetailFor", { who: isManager ? (monthlyFilter === "team" ? t("sales.wholeTeamLower") : entries.find((e) => e.salesmanId === monthlyFilter)?.name ?? "") : t("sales.youLower") })}
          </div>
          {isManager && (
            <select
              className="px-2.5 py-1 rounded-card border border-hairline bg-surface text-caption"
              value={monthlyFilter}
              onChange={(e) => setMonthlyFilter(e.target.value)}
            >
              <option value="team">{t("sales.wholeTeam")}</option>
              {[...entries].sort((a, b) => a.name.localeCompare(b.name)).map((e) => (
                <option key={e.salesmanId} value={e.salesmanId}>{e.name}</option>
              ))}
            </select>
          )}
        </div>
        <table className="w-full text-subhead min-w-[560px]">
          <thead>
            <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
              <th className="py-2 pe-3 font-medium">{t("sales.month")}</th>
              <th className="py-2 px-3 font-medium text-right tabular-nums">{t("sales.sale")}</th>
              <th className="py-2 px-3 font-medium text-right tabular-nums">{t("sales.target")}</th>
              <th className="py-2 px-3 font-medium text-right tabular-nums">{t("sales.tgtPct")}</th>
              <th className="py-2 px-3 font-medium text-right tabular-nums">{t("sales.pastYear")}</th>
              <th className="py-2 ps-3 font-medium text-right tabular-nums">{t("sales.yoy")}</th>
            </tr>
          </thead>
          <tbody>
            {monthly.map((m) => {
              const tgtPct = monthlyTarget > 0 ? (m.sale / monthlyTarget) * 100 : 0;
              const yoy = m.pastYear > 0 ? ((m.sale - m.pastYear) / m.pastYear) * 100 : null;
              return (
                <tr key={m.label} className="border-b border-hairline last:border-0">
                  <td className="py-2 pe-3 font-medium">{m.label}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{formatAed(m.sale)}</td>
                  <td className="py-2 px-3 text-right tabular-nums text-secondary">{formatAed(monthlyTarget)}</td>
                  <td className="py-2 px-3 text-right tabular-nums">{Math.round(tgtPct)}%</td>
                  <td className="py-2 px-3 text-right tabular-nums text-secondary">{formatAed(m.pastYear)}</td>
                  <td
                    className={`py-2 ps-3 text-right tabular-nums font-semibold ${
                      yoy === null ? "text-secondary" : yoy >= 0 ? "text-accent" : "text-[--status-danger]"
                    }`}
                  >
                    {yoy === null ? t("common.notSet") : `${yoy >= 0 ? ">" : "<"}${Math.abs(Math.round(yoy))}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    ),
  };

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">{t("nav.sales")}</h1>
        <div className="flex items-center gap-3">
          <WidgetAdjustPopover
            order={salesOrder}
            labels={SALES_WIDGET_LABELS}
            onChange={(next) => updatePrefs({ salesLayout: next })}
            sizes={salesSizes}
            onChangeSize={(key, size) =>
              updatePrefs({ salesSizes: { ...(preferences.salesSizes ?? {}), [key]: size } })
            }
          />
        </div>
      </div>

      {loading ? (
        <SkeletonList rows={5} />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-stretch">
          {salesOrder.map((key) => (
            <motion.div
              key={key}
              layout
              data-widget-key={key}
              transition={springLayout}
              // "stats" is a strip of figures, not a chart card, so it keeps
              // its natural height like the dashboard's equivalent.
              className={
                key === "stats"
                  ? SIZE_SPAN[salesSizes[key]].replace(/ ?min-h-\[[^\]]+\]/, "")
                  : SIZE_SPAN[salesSizes[key]]
              }
            >
              {/* Same right-click resize/remove as the Dashboard. */}
              <WidgetContextMenu
                className="h-full"
                size={salesSizes[key]}
                label={SALES_WIDGET_LABELS[key]}
                onChangeSize={(size) =>
                  updatePrefs({ salesSizes: { ...(preferences.salesSizes ?? {}), [key]: size } })
                }
                onRemove={() =>
                  updatePrefs({ salesLayout: salesOrder.filter((k) => k !== key) })
                }
              >
                {salesWidgets[key]}
              </WidgetContextMenu>
            </motion.div>
          ))}
        </div>
      )}

      {drilldownSalesman && (
        <SalesmanDrilldown
          entry={drilldownSalesman}
          rank={
            [...entries].sort((a, b) => b.total - a.total).findIndex((e) => e.salesmanId === drilldownSalesman.salesmanId) + 1
          }
          onClose={() => setDrilldownSalesman(null)}
        />
      )}
    </div>
  );
}
