import type { SupabaseClient } from "@supabase/supabase-js";
import { billingDateColumn, billedAtSelect } from "@/lib/billingDate";
import type { OrderStatus } from "@/lib/types/db";
import { fetchOutstandingInvoices, getOverdueThresholdDays } from "@/lib/queries/aging";
import { BILLED_STATUSES } from "@/lib/billedStatuses";
import { t } from "@/lib/i18n";
import { fetchAllForIds, fetchAllPages } from "@/lib/paging";
import { effectiveQty, toAed, toFils } from "@/lib/money";

// Every read of orders, order lines and payments in this file is paged
// (lib/paging.ts). One request stops at 1,000 rows without saying so, and a
// sales figure made from the first thousand orders looks exactly like a
// sales figure.

// Sales goals used to be a hardcoded 100,000 here, because the schema had
// nowhere to store them. They now live in the database — per salesman, with
// a company-wide fallback — in lib/queries/targets.ts. The constant is gone
// deliberately: leaving it around invites a screen to quietly go back to
// showing everyone the same number.

// Sale value excluding VAT. Falls back to `total` only for legacy rows that
// predate the subtotal column, so a historic order still counts for
// something rather than silently reading as zero.
export function saleValue(o: { subtotal?: number | null; total?: number | null }): number {
  return o.subtotal ?? o.total ?? 0;
}

// One trip for the orders every figure on this page is made of.
//
// The Dashboard and the Sales page each ask eight or nine different
// questions of the same set of orders — month to date, the trend line, today
// against the same day last month and last year, twelve months of history,
// last year's twelve for the comparison, the leaderboard, the receivables
// split. Each one used to fetch the whole set again: on the live database
// that is 535 rows and about 800ms, eight or nine times over, before a
// single number appears.
//
// They now share one fetch. The window is bounded to the last twenty-five
// months, which is everything any of those figures reach back to, and it is
// held for ten seconds — long enough to cover one page load, short enough
// that nothing on screen is meaningfully behind. `invalidateOrderFacts()`
// drops it the moment an order is written.
export interface RevenueOrder {
  id: string;
  salesman_id: string | null;
  subtotal: number | null;
  total: number | null;
  // The billing date: orders.billed_at, or updated_at under that name on a
  // database without RUN-ME-27 (lib/billingDate.ts).
  billed_at: string;
}

const REVENUE_TTL_MS = 10_000;
const REVENUE_MONTHS_BACK = 25;
let revenueCache: { at: number; since: string; rows: RevenueOrder[] } | null = null;
let revenueInFlight: { since: string; rows: Promise<RevenueOrder[]> } | null = null;

export function invalidateOrderFacts() {
  revenueCache = null;
}

function revenueWindowIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() - REVENUE_MONTHS_BACK, 1).toISOString();
}

// With the month chooser a page can ask about a month whose year-earlier
// comparison sits before the usual twenty-five months; the window then
// stretches back to cover it rather than quietly reading zero.
async function revenueOrders(supabase: SupabaseClient, needFrom?: Date): Promise<RevenueOrder[]> {
  const usual = revenueWindowIso();
  const since = needFrom && needFrom.toISOString() < usual ? needFrom.toISOString() : usual;
  if (revenueCache && revenueCache.since <= since && Date.now() - revenueCache.at < REVENUE_TTL_MS) {
    return revenueCache.rows;
  }
  if (revenueInFlight && revenueInFlight.since <= since) return revenueInFlight.rows;

  const pending = (async () => {
    const statuses = BILLED_STATUSES;
    const billed = await billingDateColumn(supabase);
    const rows = await fetchAllPages<RevenueOrder>(
      (from, to) =>
        supabase
          .from("orders")
          .select(`id, salesman_id, subtotal, total, ${billedAtSelect(billed)}`)
          .in("status", statuses)
          .gte(billed, since)
          .order("id")
          .range(from, to) as never,
      { keyOf: (o) => o.id }
    );
    // Never trade a wider fresh window for a narrower one.
    const keep = revenueCache && revenueCache.since < since && Date.now() - revenueCache.at < REVENUE_TTL_MS;
    if (!keep) revenueCache = { at: Date.now(), since, rows };
    return rows;
  })().finally(() => {
    if (revenueInFlight?.rows === pending) revenueInFlight = null;
  });
  revenueInFlight = { since, rows: pending };

  return pending;
}

/** The counted orders in a window, for one salesman or the whole team. */
export async function revenueIn(
  supabase: SupabaseClient,
  opts: { from?: Date; to?: Date; salesmanId?: string } = {}
): Promise<RevenueOrder[]> {
  const rows = await revenueOrders(supabase, opts.from);
  const fromMs = opts.from ? opts.from.getTime() : -Infinity;
  const toMs = opts.to ? opts.to.getTime() : Infinity;
  return rows.filter((o) => {
    if (opts.salesmanId && o.salesman_id !== opts.salesmanId) return false;
    const t = new Date(o.billed_at).getTime();
    return t >= fromMs && t <= toMs;
  });
}

// A calendar month on this device's clock. `month` is 0-based, as in Date.
// The Sales page and the Dashboard both have a month chooser, and every
// "this month" figure below takes one; leaving it out means the current
// month, which is what every other caller has always had.
export interface Month {
  year: number;
  month: number;
}

export function currentMonth(): Month {
  const d = new Date();
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function isCurrentMonth(m: Month): boolean {
  const c = currentMonth();
  return m.year === c.year && m.month === c.month;
}

/** Local midnight on the 1st to the last millisecond of the month. */
export function monthBounds(m: Month = currentMonth()): { from: Date; to: Date } {
  const from = new Date(m.year, m.month, 1);
  const to = new Date(new Date(m.year, m.month + 1, 1).getTime() - 1);
  return { from, to };
}

/** YYYY-MM-DD from the local date — not toISOString, which is a day early here before 4am. */
export function localDateKey(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function startOfMonthIso(m?: Month): string {
  return monthBounds(m).from.toISOString();
}

// Sales figure = value of approved (billed) orders this month. `orders.total` is
// stored directly in this schema revision, so no item-level aggregation
// needed. It is dated by the billing date (lib/billingDate.ts).
// Revenue is the SALE value, before VAT — `orders.subtotal`, not
// `orders.total`. total includes VAT, so summing it overstated every sales
// figure in the app by the VAT rate and understated GP% correspondingly
// (gross profit is computed pre-VAT from line items). Receivables and
// balances deliberately keep using `total`, because what a customer owes
// does include the VAT.
export async function monthToDateSales(
  supabase: SupabaseClient,
  salesmanId?: string,
  month?: Month
): Promise<number> {
  const rows = await revenueIn(supabase, { ...monthBounds(month), salesmanId });
  return rows.reduce((sum, o) => sum + saleValue(o), 0);
}

// "Orders this month" sits directly beside "Sales this month" on the
// Dashboard, and beside the revenue figure for the same window on Sales.
// It used to count by `created_at` and across every status, while the money
// beside it summed counted-status orders by `updated_at` (the billing date).
// The two disagreed by construction: in a month where six orders were billed
// but none were first drafted, the tile read "0 orders — AED 7,799". Both
// numbers now come out of the same set of rows, so a count and its money can
// never tell different stories again.
export async function countOrdersThisMonth(
  supabase: SupabaseClient,
  salesmanId?: string,
  month?: Month
): Promise<number> {
  const rows = await revenueIn(supabase, { ...monthBounds(month), salesmanId });
  return rows.length;
}

export async function countByStatus(
  supabase: SupabaseClient,
  statuses: OrderStatus[],
  salesmanId?: string
): Promise<number> {
  let q = supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .in("status", statuses);
  if (salesmanId) q = q.eq("salesman_id", salesmanId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

interface SafeItemRow {
  id: string;
  order_id: string;
  product_id: string;
  sku: string | null;
  description: string | null;
  unit_price: number;
  unit_cost: number | null;
  ordered_qty: number;
  picked_qty: number | null;
}

// Every line of the given orders, through the view that hides cost from
// whoever may not see it.
function fetchSafeItems(supabase: SupabaseClient, orderIds: string[]): Promise<SafeItemRow[]> {
  return fetchAllForIds<SafeItemRow>(
    orderIds,
    (chunk, from, to) =>
      supabase
        .from("order_items_safe")
        .select("id, order_id, product_id, sku, description, unit_price, unit_cost, ordered_qty, picked_qty")
        .in("order_id", chunk)
        .order("id")
        .range(from, to) as never,
    { keyOf: (it) => it.id }
  );
}

export interface GrossProfit {
  /** Sale less cost, over the sale whose cost is known. */
  gp: number;
  /** The sale GP was worked out on — what GP % is a percentage of. */
  costedSale: number;
  /** Sale with no cost behind it, left out of both figures above. */
  uncostedSale: number;
}

// Manager-only figure (needs unit_cost, which order_items_safe gives a
// manager and nulls for anyone else).
//
// GP used to be Σ (unit_price − unit_cost) × qty over every line, and the
// screens divided it by the whole month's sale for GP %. That was wrong
// three ways, all visible on the live data for September 2026:
//  - An order with no lines (every imported invoice — 28 of September's 43,
//    AED 32,373 of AED 82,476) has a sale and no cost. It added nothing to
//    GP and all of its sale to the divisor: GP % read 32% for orders that
//    actually made 53%.
//  - A line with no cost recorded counted as pure profit (`unit_cost ?? 0`).
//  - The order discount (RUN-ME-28) is taken off `subtotal`, not off any
//    line, so it never reached GP.
// Now each order's GP is its sale (`subtotal`, net of the discount) less
// its cost. A line with no cost leaves that line's value out of both sides,
// and an order with no lines leaves out entirely; both are reported as
// `uncostedSale` so the screen can say so.
export async function grossProfitIn(
  supabase: SupabaseClient,
  opts: { from?: Date; to?: Date; salesmanId?: string }
): Promise<GrossProfit> {
  const orders = await revenueIn(supabase, opts);
  const out: GrossProfit = { gp: 0, costedSale: 0, uncostedSale: 0 };
  if (orders.length === 0) return out;

  const items = await fetchSafeItems(
    supabase,
    orders.map((o) => o.id)
  );
  const byOrder = new Map<string, SafeItemRow[]>();
  for (const it of items) {
    const list = byOrder.get(it.order_id) ?? [];
    list.push(it);
    byOrder.set(it.order_id, list);
  }

  // In fils, so a month of lines adds up exactly (lib/money.ts).
  let gpFils = 0;
  let costedFils = 0;
  let uncostedFils = 0;
  for (const o of orders) {
    const saleFils = toFils(saleValue(o));
    const lines = byOrder.get(o.id) ?? [];
    if (lines.length === 0) {
      uncostedFils += saleFils;
      continue;
    }
    let costFils = 0;
    let noCostFils = 0;
    for (const it of lines) {
      const qty = effectiveQty(it);
      if (it.unit_cost == null) noCostFils += Math.round(toFils(it.unit_price) * qty);
      else costFils += Math.round(toFils(it.unit_cost) * qty);
    }
    const costed = Math.max(0, saleFils - noCostFils);
    if (costed === 0 && costFils === 0) {
      uncostedFils += saleFils;
      continue;
    }
    costedFils += costed;
    uncostedFils += saleFils - costed;
    gpFils += costed - costFils;
  }
  return { gp: toAed(gpFils), costedSale: toAed(costedFils), uncostedSale: toAed(uncostedFils) };
}

export async function monthToDateGrossProfit(
  supabase: SupabaseClient,
  salesmanId?: string,
  month?: Month
): Promise<GrossProfit> {
  return grossProfitIn(supabase, { ...monthBounds(month), salesmanId });
}

/** GP as a percentage of the sale it was worked out on, or null when there is none. */
export function gpPercent(g: GrossProfit): number | null {
  return g.costedSale > 0 ? (g.gp / g.costedSale) * 100 : null;
}

// Avg. GP% for one salesman over an arbitrary window (§sales-salesman
// mockup's "Avg. GP%" card). Returns null when there's nothing costed in
// the window — including for anyone but a manager, whose lines come back
// with no cost — so the UI can show "—" instead of a misleading figure.
export async function salesmanAvgGpPercent(
  supabase: SupabaseClient,
  salesmanId: string,
  from: Date,
  to: Date
): Promise<number | null> {
  return gpPercent(await grossProfitIn(supabase, { from, to, salesmanId }));
}

// Item count per order, for the Orders list's "N items" subtitle.
export async function orderItemCounts(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Record<string, number>> {
  if (orderIds.length === 0) return {};
  let data: { id: string; order_id: string }[];
  try {
    data = await fetchAllForIds<{ id: string; order_id: string }>(
      orderIds,
      (chunk, from, to) =>
        supabase.from("order_items").select("id, order_id").in("order_id", chunk).order("id").range(from, to) as never,
      { keyOf: (row) => row.id }
    );
  } catch {
    return {};
  }
  const counts: Record<string, number> = {};
  for (const row of data) counts[row.order_id] = (counts[row.order_id] ?? 0) + 1;
  return counts;
}

export interface DailyPoint {
  label: string;
  value: number;
}

// Daily approved-order sale total for the trailing `days` days, oldest
// first — feeds the dashboard's trend sparkline.
export async function fetchSaleTrend(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; days?: number; from?: Date; to?: Date } = {}
): Promise<DailyPoint[]> {
  // Explicit from/to (custom date-range picker, §Dashboard) wins over the
  // days-back shorthand when both could apply.
  const to = opts.to ?? new Date();
  // A copy: this used to call setHours on the caller's own Date, so anything
  // else the caller passed that same object to saw a window that had quietly
  // moved underneath it.
  const start = new Date(
    opts.from ??
      (() => {
        const d = new Date(to);
        d.setDate(d.getDate() - ((opts.days ?? 30) - 1));
        return d;
      })()
  );
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);

  const data = await revenueIn(supabase, { from: start, to: end, salesmanId: opts.salesmanId });

  // Both sides keyed by the local date. The orders used to be keyed by their
  // UTC date and the days by toISOString() of local midnight — which is the
  // day before, here — so each point showed the sale of the day before the
  // one on its label.
  const byDay = new Map<string, number>();
  for (const o of data ?? []) {
    const key = localDateKey(new Date(o.billed_at as string));
    byDay.set(key, (byDay.get(key) ?? 0) + saleValue(o));
  }

  // One point per calendar day from start to end. This used to round the
  // span (ending at 23:59:59.999) up and add one, which drew a point for the
  // day after the window — "30 days" was 31 points, the last one tomorrow.
  const points: DailyPoint[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = localDateKey(d);
    points.push({ label: String(d.getDate()), value: byDay.get(key) ?? 0 });
  }
  return points;
}

// Approved-order sale total for a single calendar day — feeds the Sales
// trend widget's day-level comparisons (§Next Updates: "% comparison vs the
// same day last month AND same day last year", distinct from the existing
// MoM/YoY badges which compare whole-month totals).
export async function salesOnDay(
  supabase: SupabaseClient,
  date: Date,
  salesmanId?: string
): Promise<number> {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setHours(23, 59, 59, 999);

  const rows = await revenueIn(supabase, { from: start, to: end, salesmanId });
  return rows.reduce((sum, o) => sum + saleValue(o), 0);
}

export interface MonthPoint {
  label: string;
  value: number;
}

const MONTH_LABELS = [
  t("dashboard.monthJanUpper"),
  t("dashboard.monthFebUpper"),
  t("dashboard.monthMarUpper"),
  t("dashboard.monthAprUpper"),
  t("dashboard.monthMayUpper"),
  t("dashboard.monthJunUpper"),
  t("dashboard.monthJulUpper"),
  t("dashboard.monthAugUpper"),
  t("dashboard.monthSepUpper"),
  t("dashboard.monthOctUpper"),
  t("dashboard.monthNovUpper"),
  t("dashboard.monthDecUpper"),
];

export interface MonthSegments {
  label: string;
  cleared: number;
  bounced: number;
  other: number;
}

// Same trailing-12-months payment totals as fetchPaymentsByMonth, but split
// by cheque_status (§Next Updates dashboard mockup: the Payments bar chart
// is multi-colored per bar, not a flat single color) — cleared cheques +
// cash render as the accent color, bounced/returned as danger, everything
// still pending as neutral.
export async function fetchPaymentsByMonthSegmented(
  supabase: SupabaseClient,
  opts: { collectedBy?: string; endMonth?: Month } = {}
): Promise<MonthSegments[]> {
  // The twelve months ending with the chosen one (this one by default).
  const end = opts.endMonth ?? currentMonth();
  const start = new Date(end.year, end.month - 11, 1);
  const endExclusive = new Date(end.year, end.month + 1, 1);

  type Row = { id: string; amount: number | string; created_at: string; cheque_status: string | null };
  const data = await fetchAllPages<Row>(
    (from, to) => {
      let q = supabase
        .from("payments")
        .select("id, amount, created_at, collector_id, cheque_status")
        .eq("status", "confirmed")
        .gte("created_at", start.toISOString())
        .lt("created_at", endExclusive.toISOString());
      if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
      return q.order("id").range(from, to) as never;
    },
    { keyOf: (p) => p.id }
  );

  const byMonth = new Map<string, { cleared: number; bounced: number; other: number }>();
  for (const p of data) {
    const d = new Date(p.created_at as string);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = byMonth.get(key) ?? { cleared: 0, bounced: 0, other: 0 };
    // `amount` is a Postgres numeric column — PostgREST serializes those as
    // strings, so `+=` would silently string-concatenate instead of adding
    // without this Number() coercion.
    const amount = Number(p.amount) || 0;
    if (p.cheque_status === "bounced" || p.cheque_status === "returned") bucket.bounced += amount;
    else if (p.cheque_status === "cleared" || p.cheque_status == null) bucket.cleared += amount;
    else bucket.other += amount;
    byMonth.set(key, bucket);
  }

  const points: MonthSegments[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    const bucket = byMonth.get(key) ?? { cleared: 0, bounced: 0, other: 0 };
    points.push({ label: MONTH_LABELS[d.getMonth()], ...bucket });
  }
  return points;
}

// Trailing-12-months bucketing (optionally shifted back a further N years),
// for approved-order sale totals — feeds the salesman year-over-year bar
// chart and the Sales monthly detail table's "Past Year" column.
export async function fetchSalesByMonth(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; yearsAgo?: number; endMonth?: Month } = {}
): Promise<MonthPoint[]> {
  // The twelve months ending with the chosen one (this one by default).
  const last = opts.endMonth ?? currentMonth();
  const yearsAgo = opts.yearsAgo ?? 0;
  const start = new Date(last.year - yearsAgo, last.month - 11, 1);
  const end = new Date(last.year - yearsAgo, last.month + 1, 1);

  // `end` is exclusive here (the first of next month), so step back a
  // millisecond rather than including it.
  const data = await revenueIn(supabase, {
    from: start,
    to: new Date(end.getTime() - 1),
    salesmanId: opts.salesmanId,
  });

  const byMonth = new Map<string, number>();
  for (const o of data ?? []) {
    const d = new Date(o.billed_at as string);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    byMonth.set(key, (byMonth.get(key) ?? 0) + saleValue(o));
  }

  const points: MonthPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    points.push({ label: MONTH_LABELS[d.getMonth()], value: byMonth.get(key) ?? 0 });
  }
  return points;
}

export interface TopCustomer {
  customerId: string;
  name: string;
  total: number;
}

// Top customers by approved-order value this month.
export async function fetchTopCustomers(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; limit?: number } = {}
): Promise<TopCustomer[]> {
  const statuses = BILLED_STATUSES;
  const billed = await billingDateColumn(supabase);
  type Row = { id: string; customer_id: string; subtotal: number | null; total: number | null };
  const data = await fetchAllPages<Row>(
    (from, to) => {
      let q = supabase
        .from("orders")
        .select("id, customer_id, subtotal, total")
        .in("status", statuses)
        .gte(billed, startOfMonthIso())
        .not("customer_id", "is", null);
      if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
      return q.order("id").range(from, to) as never;
    },
    { keyOf: (o) => o.id }
  );

  const totals = new Map<string, number>();
  for (const o of data) {
    const id = o.customer_id as string;
    totals.set(id, (totals.get(id) ?? 0) + saleValue(o));
  }
  const ids = [...totals.keys()];
  if (ids.length === 0) return [];

  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("id, name")
    .in("id", ids);
  if (custErr) throw custErr;
  const nameById = new Map((customers ?? []).map((c) => [c.id, c.name]));

  return ids
    .map((id) => ({ customerId: id, name: nameById.get(id) ?? t("common.notSet"), total: totals.get(id) ?? 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, opts.limit ?? 5);
}

export interface PaymentsSummary {
  pendingCount: number;
  received: number;
  overdue: number;
  // Outstanding balance still inside its payment terms
  // (§Next Updates dashboard mockup: "Collected / Remaining / Overdue").
  remaining: number;
}

// Collected = confirmed payments this month.
// Remaining = what is still owed and still inside its terms — younger than
//   the overdue threshold (90 days by default, or whatever a customer's own
//   threshold says), including anything whose due date has been extended.
// Overdue = what is owed past that threshold and has not been extended.
// Pending = how many invoices make up Remaining.
// Scoped to a salesman's own orders when salesmanId is given.
export async function fetchPaymentsSummary(
  supabase: SupabaseClient,
  // `month` moves Collected only. Remaining and Overdue are what is owed
  // today; there is no reading of what was owed at the end of a past month.
  opts: { salesmanId?: string; collectedBy?: string; month?: Month } = {}
): Promise<PaymentsSummary> {
  // One reading of what a customer owes, shared with the Customers page and
  // the statements: confirmed payments and approved returns already taken
  // off, and an order whose due date has been extended aged from the new
  // date rather than from the billing date.
  const [invoices, defaultDays] = await Promise.all([
    fetchOutstandingInvoices(supabase, undefined, false, opts.salesmanId),
    getOverdueThresholdDays(supabase),
  ]);

  const customerIds = [...new Set(invoices.map((inv) => inv.customerId).filter(Boolean))];
  const { data: customers } = customerIds.length
    ? await supabase.from("customers").select("id, overdue_threshold_days").in("id", customerIds)
    : { data: [] as { id: string; overdue_threshold_days: number | null }[] };
  const thresholdById = new Map(
    (customers ?? []).map((c) => [c.id as string, (c.overdue_threshold_days ?? defaultDays) as number])
  );

  let pendingCount = 0;
  let overdue = 0;
  let remaining = 0;
  for (const inv of invoices) {
    if (inv.balance <= 0.01) continue;
    const threshold = thresholdById.get(inv.customerId) ?? defaultDays;
    // Remaining is what is still inside its terms; overdue is what has run
    // past them and has not been extended. An extension moves an invoice
    // back into Remaining until the new date passes.
    if (inv.daysOutstanding > threshold) overdue += inv.balance;
    else {
      pendingCount += 1;
      remaining += inv.balance;
    }
  }

  const received = await monthToDateConfirmedPayments(supabase, opts.collectedBy, opts.month);
  return { pendingCount, received, overdue, remaining };
}

// Approved-order count and confirmed-payments total for an arbitrary
// [from, to] date range — feeds Sales' adjustable-date orders/payments
// widgets (§Sales: "widgets of orders and payments received, adjustable
// with date").
// Same rule as countOrdersThisMonth, for an arbitrary window: the orders
// counted here are exactly the orders whose money the caller is showing.
export async function countOrdersInRange(
  supabase: SupabaseClient,
  opts: { from: Date; to: Date; salesmanId?: string }
): Promise<number> {
  const start = new Date(opts.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(opts.to);
  end.setHours(23, 59, 59, 999);
  const rows = await revenueIn(supabase, {
    from: start,
    to: end,
    salesmanId: opts.salesmanId,
  });
  return rows.length;
}

export async function paymentsReceivedInRange(
  supabase: SupabaseClient,
  opts: { from: Date; to: Date; collectedBy?: string }
): Promise<number> {
  const start = new Date(opts.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(opts.to);
  end.setHours(23, 59, 59, 999);
  return confirmedPaymentsTotal(supabase, { fromIso: start.toISOString(), toIso: end.toISOString(), collectedBy: opts.collectedBy });
}

async function monthToDateConfirmedPayments(supabase: SupabaseClient, collectedBy?: string, month?: Month): Promise<number> {
  const { from, to } = monthBounds(month);
  return confirmedPaymentsTotal(supabase, { fromIso: from.toISOString(), toIso: to.toISOString(), collectedBy });
}

// Σ amount of confirmed payments in a window. The arithmetic is what both
// callers already did; only the reading is new — every page, not the first.
async function confirmedPaymentsTotal(
  supabase: SupabaseClient,
  opts: { fromIso: string; toIso?: string; collectedBy?: string }
): Promise<number> {
  const data = await fetchAllPages<{ id: string; amount: number }>(
    (from, to) => {
      let q = supabase.from("payments").select("id, amount").eq("status", "confirmed").gte("created_at", opts.fromIso);
      if (opts.toIso) q = q.lte("created_at", opts.toIso);
      if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
      return q.order("id").range(from, to) as never;
    },
    { keyOf: (p) => p.id }
  );
  return data.reduce((s, p) => s + p.amount, 0);
}

export interface ExpenseSlice {
  label: string;
  value: number;
}

export interface CategorySale {
  label: string;
  value: number;
  units: number;
}

// §Dashboard: "add a category/product-wise sales report widget (hidden by
// default, optional)". Revenue and units for this month's approved orders,
// grouped either by product category or by individual product. Uses the
// picked qty when there is one, matching how invoices and every other sales
// figure in the app are computed.
export async function fetchSalesByCategory(
  supabase: SupabaseClient,
  opts: { groupBy?: "category" | "product"; salesmanId?: string; limit?: number; month?: Month } = {}
): Promise<CategorySale[]> {
  const statuses = BILLED_STATUSES;
  const billed = await billingDateColumn(supabase);
  const { from: monthFrom, to: monthTo } = monthBounds(opts.month);
  const orders = await fetchAllPages<{ id: string }>(
    (from, to) => {
      let orderQ = supabase
        .from("orders")
        .select("id")
        .in("status", statuses)
        .gte(billed, monthFrom.toISOString())
        .lte(billed, monthTo.toISOString());
      if (opts.salesmanId) orderQ = orderQ.eq("salesman_id", opts.salesmanId);
      return orderQ.order("id").range(from, to) as never;
    },
    { keyOf: (o) => o.id }
  );
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length === 0) return [];

  // The widget has always drawn empty, rather than failed, when the lines
  // cannot be read.
  const rows = await fetchSafeItems(supabase, orderIds).catch(() => [] as SafeItemRow[]);
  if (rows.length === 0) return [];

  // Categories live on `products`, not on the order-item snapshot, so they
  // need a lookup. A failure here degrades to grouping by product rather
  // than breaking the widget.
  let categoryByProduct = new Map<string, string>();
  if (opts.groupBy !== "product") {
    try {
      const res = await fetch("/api/products?activeOnly=false");
      const json = await res.json();
      if (res.ok) {
        categoryByProduct = new Map(
          (json.products ?? [])
            .filter((p: { id: string; category?: string | null }) => p.category)
            .map((p: { id: string; category: string }) => [p.id, p.category])
        );
      }
    } catch {
      /* fall through to product-level grouping */
    }
  }

  const byLabel = new Map<string, { value: number; units: number }>();
  for (const it of rows) {
    const qty = it.picked_qty ?? it.ordered_qty ?? 0;
    const label =
      opts.groupBy === "product"
        ? it.description || it.sku || t("dashboard.unknownProduct")
        : categoryByProduct.get(it.product_id) ?? t("dashboard.uncategorized");
    const cur = byLabel.get(label) ?? { value: 0, units: 0 };
    cur.value += qty * (it.unit_price ?? 0);
    cur.units += qty;
    byLabel.set(label, cur);
  }

  return [...byLabel.entries()]
    .map(([label, v]) => ({ label, ...v }))
    .sort((a, b) => b.value - a.value)
    .slice(0, opts.limit ?? 12);
}

// Groups this month's expenses by category (falling back to type when a row
// has no category), matching the donut legend in the design mockups.
// Goes through /api/expenses (service-role, Manager-gated) rather than a
// direct anon-key query — the `expenses` RLS policy still references the
// old `users.auth_id` column and 400s on every anon-key query; see
// app/api/expenses/route.ts.
export async function fetchExpenseBreakdown(_supabase: SupabaseClient, month?: Month): Promise<{
  slices: ExpenseSlice[];
  total: number;
}> {
  const res = await fetch("/api/expenses");
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? t("dashboard.failedToLoadExpenses"));
  // `date` is a plain calendar date, so compare it with local dates. This
  // used to be toISOString() of local midnight on the 1st — the last day of
  // the previous month here — so that day's expenses counted twice.
  const { from, to } = monthBounds(month);
  const monthStart = localDateKey(from);
  const monthEnd = localDateKey(to);
  const data: { type: string; category: string | null; amount: number; date: string }[] = (
    json.expenses ?? []
  ).filter((e: { date: string }) => e.date >= monthStart && e.date <= monthEnd);

  const byLabel = new Map<string, number>();
  for (const e of data) {
    const label = e.category || e.type[0].toUpperCase() + e.type.slice(1);
    byLabel.set(label, (byLabel.get(label) ?? 0) + e.amount);
  }
  const slices = [...byLabel.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
  const total = slices.reduce((s, sl) => s + sl.value, 0);
  return { slices, total };
}
