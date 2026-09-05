"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchSaleTrend,
  salesmanAvgGpPercent,
  orderItemCounts,
  type DailyPoint,
} from "@/lib/queries/dashboard";
import { fetchMonthlyTargets, FALLBACK_MONTHLY_TARGET } from "@/lib/queries/targets";
import { fetchOrders, type OrderRow } from "@/lib/queries/orders";
import { fetchCountedStatuses } from "@/lib/reportStage";
import { type LeaderboardEntry } from "@/lib/queries/sales";
import { presetToRange, SALE_RANGE_PRESETS } from "@/components/ui/DateRangePicker";
import { formatAed, formatCompact } from "@/lib/money";
import Sheet from "@/components/ui/Sheet";
import { Card } from "@/components/ui/Card";
import { TrendLineChart } from "@/components/ui/charts";

export function ExpandedStatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-subhead font-semibold">{label}:</span>
      <span className="text-headline font-bold tabular-nums text-accent">{value}</span>
    </div>
  );
}

export function EmptyStateInline({ text }: { text: string }) {
  return <div className="text-center text-subhead text-secondary py-8">{text}</div>;
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-16 skeleton rounded-card" />
      ))}
    </div>
  );
}

// Individual salesman drill-down (§Next Updates mockup: clicking a
// salesman row in the goal table opens their own trend + orders) — shared
// between the Dashboard's leaderboard widget and the Sales page's own Goal
// table, both of which open the same detail Sheet on row click.
export function SalesmanDrilldown({
  entry,
  rank,
  onClose,
}: {
  entry: LeaderboardEntry;
  // Position in the leaderboard — the green badge left of the name in the
  // mockup. Omitted when opened from somewhere without a ranking.
  rank?: number;
  onClose: () => void;
}) {
  const [trend, setTrend] = useState<DailyPoint[]>([]);
  const [prevTrend, setPrevTrend] = useState<DailyPoint[]>([]);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const [gpPct, setGpPct] = useState<number | null>(null);
  const [days, setDays] = useState(30);
  const [target, setTarget] = useState(FALLBACK_MONTHLY_TARGET);
  // Everything below the chart used to read from `entry`, which is always
  // the current month to date no matter what this picker says. Pick Year to
  // date and only the graph changed. These follow the range instead.
  const [rangeSale, setRangeSale] = useState(0);
  const [rangeDays, setRangeDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      const supabase = supabaseBrowser();
      const range = presetToRange(days);
      // Local midnight to local end-of-day. `new Date("2026-09-04")` is UTC
      // midnight, so the plain form cut today off the end of every window —
      // the orders and the GP% quietly stopped a few hours short.
      const from = new Date(`${range.from}T00:00:00`);
      const to = new Date(`${range.to}T23:59:59.999`);
      const rangeMs = to.getTime() - from.getTime();
      const prevTo = new Date(from.getTime() - 1);
      const prevFrom = new Date(prevTo.getTime() - rangeMs);
      const counted = await fetchCountedStatuses(supabase);
      const [tr, ptr, ords, gp] = await Promise.all([
        fetchSaleTrend(supabase, { salesmanId: entry.salesmanId, from: new Date(from), to }),
        fetchSaleTrend(supabase, { salesmanId: entry.salesmanId, from: prevFrom, to: prevTo }),
        // The orders that make up the figure beside them: same window, same
        // statuses the sale total counts, rather than the latest twelve of
        // anything at any date.
        fetchOrders(supabase, {
          salesmanId: entry.salesmanId,
          status: counted,
          from,
          to,
          limit: 200,
        }),
        salesmanAvgGpPercent(supabase, entry.salesmanId, from, to).catch(() => null),
      ]);
      const counts = await orderItemCounts(supabase, ords.map((o) => o.id));
      const targets = await fetchMonthlyTargets(supabase);
      if (cancelled) return;
      setTarget(targets.forUser(entry.salesmanId));
      // Summed from the same daily series the chart draws, so the number and
      // the line can never disagree.
      setRangeSale(tr.reduce((sum, p) => sum + p.value, 0));
      // `to` is already the end of its day, so the difference is the whole
      // inclusive span — adding one would count a thirty-first day.
      setRangeDays(Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000)));
      setTrend(tr);
      setPrevTrend(ptr);
      setOrders(ords);
      setItemCounts(counts);
      setGpPct(gp);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.salesmanId, days]);

  // The goal is a monthly one, so a window longer than a month is measured
  // against proportionally more of it — Year to date against nine months of
  // goal, not one. Anything a month or shorter keeps the full monthly
  // figure, which is how the leaderboard has always read it.
  const monthsInRange = Math.max(1, rangeDays / 30.4375);
  const periodTarget = Math.round(target * monthsInRange);
  const pct = periodTarget > 0 ? (rangeSale / periodTarget) * 100 : 0;
  const rangeLabelText =
    SALE_RANGE_PRESETS.find((p) => p.days === days)?.label ?? `${days} days`;

  return (
    <Sheet
      open
      onClose={onClose}
      title={entry.name}
      // §mockup: rank badge left of the name, range picker on the right.
      titlePrefix={
        rank !== undefined ? (
          <span className="w-7 h-7 shrink-0 rounded-full bg-accent/15 text-accent grid place-items-center text-subhead font-bold tabular-nums">
            {rank}
          </span>
        ) : undefined
      }
      headerExtra={
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-card border border-hairline bg-surface px-3 py-1.5 text-subhead font-semibold"
          aria-label="Date range"
        >
          {SALE_RANGE_PRESETS.map((p) => (
            <option key={p.days} value={p.days}>
              {p.label === "Month to date" || p.label === "Year to date" ? p.label : `Last ${p.label}`}
            </option>
          ))}
        </select>
      }
    >
      {loading ? (
        <SkeletonRows />
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-4 items-start">
          <Card className="p-4">
            <div className="text-title font-bold mb-3">Sale</div>
            <TrendLineChart
              values={trend.map((t) => t.value)}
              compareValues={prevTrend.map((t) => t.value)}
              height={260}
              showAverage
            />
            <div className="mt-2 flex items-center gap-4 text-caption text-secondary">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded-full bg-accent" /> {rangeLabelText}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded-full bg-secondary/50" /> Previous period
              </span>
            </div>
          </Card>

          <div className="flex flex-col gap-3">
            {/* Sale — label + % stacked left, big number right */}
            <Card className="p-4 flex items-end justify-between gap-3">
              <div>
                <div className="text-title font-bold leading-tight">Sale</div>
                <div className="text-caption text-secondary">{rangeLabelText}</div>
                <div className="text-headline font-bold tabular-nums text-accent">{Math.round(pct)}%</div>
              </div>
              <div className="text-title font-bold tabular-nums text-accent truncate">
                {formatAed(rangeSale)}
              </div>
            </Card>

            {/* Three across, as drawn */}
            <Card className="p-4 grid grid-cols-3 gap-2">
              <MiniStat label="% to goal" value={`${Math.round(pct)}%`} />
              <MiniStat
                label={monthsInRange > 1 ? "Goal (period)" : "Goal"}
                value={formatCompact(periodTarget)}
                align="center"
              />
              <MiniStat
                label="Amount left"
                value={formatCompact(Math.max(0, periodTarget - rangeSale))}
                align="right"
              />
            </Card>

            <Card className="p-4 flex items-center justify-between gap-3">
              <span className="text-title font-bold">Avg. GP%</span>
              <span className="text-title font-bold tabular-nums text-accent">
                {gpPct === null ? "—" : `${Math.round(gpPct)}%`}
              </span>
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className="text-title font-bold">Orders</span>
                <span className="text-subhead font-semibold tabular-nums text-secondary">
                  {orders.length}
                </span>
              </div>
              {orders.length === 0 ? (
                <EmptyStateInline text={`No orders in the ${rangeLabelText.toLowerCase()}`} />
              ) : (
                <div className="flex flex-col gap-1.5 max-h-[300px] overflow-y-auto">
                  {orders.map((o) => (
                    <div
                      key={o.id}
                      className="flex items-center justify-between gap-2 rounded-inner bg-canvas px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="text-subhead font-semibold truncate">
                          {o.customer?.name ?? o.new_customer_note ?? "Unnamed customer"}
                        </div>
                        <div className="text-[10px] text-secondary">{o.customer?.code}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-subhead font-bold tabular-nums">{formatAed(o.total ?? 0)}</div>
                        <div className="text-[10px] text-secondary tabular-nums">
                          {itemCounts[o.id] ?? 0} items
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function MiniStat({
  label,
  value,
  align = "left",
}: {
  label: string;
  value: string;
  align?: "left" | "center" | "right";
}) {
  const cls = align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
  return (
    <div className={cls}>
      <div className="text-caption text-secondary font-semibold">{label}</div>
      <div className="text-headline font-bold tabular-nums text-accent truncate">{value}</div>
    </div>
  );
}
