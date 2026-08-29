import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderStatus } from "@/lib/types/db";
import { fetchApprovedGrvCreditByCustomer } from "@/lib/queries/grv";
import { fetchCountedStatuses } from "@/lib/reportStage";

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

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

// Sales figure = value of DELIVERED orders this month. `orders.total` is
// stored directly in this schema revision, so no item-level aggregation
// needed. There's no delivered_at column anymore, so this uses updated_at
// as a proxy for "when it was last moved" — imprecise if an order is
// touched again after delivery, but there's nowhere else to read it from.
// Revenue is the SALE value, before VAT — `orders.subtotal`, not
// `orders.total`. total includes VAT, so summing it overstated every sales
// figure in the app by the VAT rate and understated GP% correspondingly
// (gross profit is computed pre-VAT from line items). Receivables and
// balances deliberately keep using `total`, because what a customer owes
// does include the VAT.
export async function monthToDateSales(
  supabase: SupabaseClient,
  salesmanId?: string
): Promise<number> {
  let q = supabase
    .from("orders")
    .select("subtotal, total")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", startOfMonthIso());
  if (salesmanId) q = q.eq("salesman_id", salesmanId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((sum, o) => sum + saleValue(o), 0);
}

export async function countOrdersThisMonth(
  supabase: SupabaseClient,
  salesmanId?: string
): Promise<number> {
  let q = supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", startOfMonthIso());
  if (salesmanId) q = q.eq("salesman_id", salesmanId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
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

// Manager-only figure (needs unit_cost). Sums grossProfit across delivered
// orders' items this month, same convention as fetchBalanceSheet in
// reports.ts (order_items_safe exposes real cost to a Manager session).
export async function monthToDateGrossProfit(
  supabase: SupabaseClient,
  salesmanId?: string
): Promise<number> {
  let orderQ = supabase
    .from("orders")
    .select("id")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", startOfMonthIso());
  if (salesmanId) orderQ = orderQ.eq("salesman_id", salesmanId);
  const { data: orders, error } = await orderQ;
  if (error) throw error;
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return 0;

  const { data: items, error: itemsErr } = await supabase
    .from("order_items_safe")
    .select("unit_price, unit_cost, ordered_qty, picked_qty")
    .in("order_id", orderIds);
  if (itemsErr) throw itemsErr;

  return (items ?? []).reduce((sum, it) => {
    const qty = it.picked_qty ?? it.ordered_qty;
    return sum + (it.unit_price - (it.unit_cost ?? 0)) * qty;
  }, 0);
}

// Avg. GP% for one salesman over an arbitrary window (§sales-salesman
// mockup's "Avg. GP%" card). Returns null when there's nothing counted in
// the window, so the UI can show "—" instead of a misleading 0%.
export async function salesmanAvgGpPercent(
  supabase: SupabaseClient,
  salesmanId: string,
  from: Date,
  to: Date
): Promise<number | null> {
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id")
    .eq("salesman_id", salesmanId)
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", from.toISOString())
    .lte("updated_at", to.toISOString());
  if (error) throw error;
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return null;

  const { data: items, error: itemsErr } = await supabase
    .from("order_items_safe")
    .select("unit_price, unit_cost, ordered_qty, picked_qty")
    .in("order_id", orderIds);
  if (itemsErr) throw itemsErr;

  let sales = 0;
  let cost = 0;
  for (const it of items ?? []) {
    const qty = it.picked_qty ?? it.ordered_qty;
    sales += it.unit_price * qty;
    cost += (it.unit_cost ?? 0) * qty;
  }
  // unit_cost comes back null for non-Manager sessions — GP is meaningless
  // there, so report nothing rather than a fake 100%.
  if (sales <= 0 || cost <= 0) return null;
  return ((sales - cost) / sales) * 100;
}

// Item count per order, for the Orders list's "N items" subtitle.
export async function orderItemCounts(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Record<string, number>> {
  if (orderIds.length === 0) return {};
  const { data, error } = await supabase
    .from("order_items")
    .select("order_id")
    .in("order_id", orderIds);
  if (error) return {};
  const counts: Record<string, number> = {};
  for (const row of data ?? []) counts[row.order_id] = (counts[row.order_id] ?? 0) + 1;
  return counts;
}

export interface DailyPoint {
  label: string;
  value: number;
}

// Daily delivered-order sale total for the trailing `days` days, oldest
// first — feeds the dashboard's trend sparkline.
export async function fetchSaleTrend(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; days?: number; from?: Date; to?: Date } = {}
): Promise<DailyPoint[]> {
  // Explicit from/to (custom date-range picker, §Dashboard) wins over the
  // days-back shorthand when both could apply.
  const to = opts.to ?? new Date();
  const start = opts.from ?? (() => {
    const d = new Date(to);
    d.setDate(d.getDate() - ((opts.days ?? 30) - 1));
    return d;
  })();
  start.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 999);
  const totalDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1);

  let q = supabase
    .from("orders")
    .select("subtotal, total, updated_at")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", start.toISOString())
    .lte("updated_at", end.toISOString());
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  const { data, error } = await q;
  if (error) throw error;

  const byDay = new Map<string, number>();
  for (const o of data ?? []) {
    const key = (o.updated_at as string).slice(0, 10);
    byDay.set(key, (byDay.get(key) ?? 0) + saleValue(o));
  }

  const points: DailyPoint[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    points.push({ label: String(d.getDate()), value: byDay.get(key) ?? 0 });
  }
  return points;
}

// Delivered-order sale total for a single calendar day — feeds the Sales
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

  let q = supabase
    .from("orders")
    .select("subtotal, total")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", start.toISOString())
    .lte("updated_at", end.toISOString());
  if (salesmanId) q = q.eq("salesman_id", salesmanId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((sum, o) => sum + saleValue(o), 0);
}

export interface MonthPoint {
  label: string;
  value: number;
}

const MONTH_LABELS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

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
  opts: { collectedBy?: string } = {}
): Promise<MonthSegments[]> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);

  let q = supabase
    .from("payments")
    .select("amount, created_at, collector_id, cheque_status")
    .eq("status", "confirmed")
    .gte("created_at", start.toISOString());
  if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
  const { data, error } = await q;
  if (error) throw error;

  const byMonth = new Map<string, { cleared: number; bounced: number; other: number }>();
  for (const p of data ?? []) {
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
// for delivered-order sale totals — feeds the salesman year-over-year bar
// chart and the Sales monthly detail table's "Past Year" column.
export async function fetchSalesByMonth(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; yearsAgo?: number } = {}
): Promise<MonthPoint[]> {
  const now = new Date();
  const yearsAgo = opts.yearsAgo ?? 0;
  const start = new Date(now.getFullYear() - yearsAgo, now.getMonth() - 11, 1);
  const end = new Date(now.getFullYear() - yearsAgo, now.getMonth() + 1, 1);

  let q = supabase
    .from("orders")
    .select("subtotal, total, updated_at")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", start.toISOString())
    .lt("updated_at", end.toISOString());
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  const { data, error } = await q;
  if (error) throw error;

  const byMonth = new Map<string, number>();
  for (const o of data ?? []) {
    const d = new Date(o.updated_at as string);
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

// Top customers by delivered-order value this month.
export async function fetchTopCustomers(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; limit?: number } = {}
): Promise<TopCustomer[]> {
  let q = supabase
    .from("orders")
    .select("customer_id, subtotal, total")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", startOfMonthIso())
    .not("customer_id", "is", null);
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  const { data, error } = await q;
  if (error) throw error;

  const totals = new Map<string, number>();
  for (const o of data ?? []) {
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
    .map((id) => ({ customerId: id, name: nameById.get(id) ?? "—", total: totals.get(id) ?? 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, opts.limit ?? 5);
}

export interface PaymentsSummary {
  pendingCount: number;
  received: number;
  overdue: number;
  // Dollar sum of outstanding balance not yet past the overdue threshold
  // (§Next Updates dashboard mockup: "Collected / Remaining / Overdue").
  remaining: number;
}

// Pending = count of outstanding (unpaid) invoices that aren't yet past the
// customer's overdue threshold. Received = confirmed payments this month.
// Overdue = balance on invoices past threshold. Scoped to a salesman's own
// orders when salesmanId is given (dashboard "own numbers" scoping).
export async function fetchPaymentsSummary(
  supabase: SupabaseClient,
  opts: { salesmanId?: string; collectedBy?: string } = {}
): Promise<PaymentsSummary> {
  let orderQ = supabase
    .from("orders")
    .select("id, customer_id, total, updated_at")
    .in("status", await fetchCountedStatuses(supabase));
  if (opts.salesmanId) orderQ = orderQ.eq("salesman_id", opts.salesmanId);
  const { data: orders, error } = await orderQ;
  if (error) throw error;
  const orderRows = orders ?? [];
  if (orderRows.length === 0) {
    const received = await monthToDateConfirmedPayments(supabase, opts.collectedBy);
    return { pendingCount: 0, received, overdue: 0, remaining: 0 };
  }

  const orderIds = orderRows.map((o) => o.id);
  const { data: links } = await supabase
    .from("payment_orders")
    .select("payment_id, order_id, allocated_amount")
    .in("order_id", orderIds);
  // A payment can span multiple orders (§6) — allocated_amount is the
  // per-order slice, not payments.amount (the whole collection).
  const paymentIds = [...new Set((links ?? []).map((l) => l.payment_id))];
  const confirmedPaymentIds = new Set<string>();
  if (paymentIds.length) {
    const { data: payments } = await supabase
      .from("payments")
      .select("id, status")
      .in("id", paymentIds)
      .eq("status", "confirmed");
    for (const p of payments ?? []) confirmedPaymentIds.add(p.id);
  }
  const paidByOrder = new Map<string, number>();
  for (const link of links ?? []) {
    if (!confirmedPaymentIds.has(link.payment_id)) continue;
    paidByOrder.set(link.order_id, (paidByOrder.get(link.order_id) ?? 0) + (link.allocated_amount ?? 0));
  }

  const customerIds = [...new Set(orderRows.map((o) => o.customer_id).filter(Boolean))] as string[];
  const { data: customers } = customerIds.length
    ? await supabase.from("customers").select("id, overdue_threshold_days").in("id", customerIds)
    : { data: [] as any[] };
  const thresholdById = new Map((customers ?? []).map((c: any) => [c.id, c.overdue_threshold_days ?? 30]));

  // An approved GRV is a credit note — apply it against the customer's
  // oldest outstanding orders first, same as fetchOutstandingInvoices does.
  const creditByCustomer = await fetchApprovedGrvCreditByCustomer(supabase, customerIds);
  const balanceById = new Map<string, number>();
  if (creditByCustomer.size > 0) {
    const byCustomer = new Map<string, typeof orderRows>();
    for (const o of orderRows) {
      const custId = o.customer_id as string | null;
      if (!custId) continue;
      if (!byCustomer.has(custId)) byCustomer.set(custId, []);
      byCustomer.get(custId)!.push(o);
    }
    for (const [custId, custOrders] of byCustomer) {
      let credit = creditByCustomer.get(custId) ?? 0;
      custOrders.sort((a, b) => new Date(a.updated_at as string).getTime() - new Date(b.updated_at as string).getTime());
      for (const o of custOrders) {
        const paid = paidByOrder.get(o.id) ?? 0;
        let balance = Math.max(0, (o.total ?? 0) - paid);
        if (credit > 0) {
          const applied = Math.min(balance, credit);
          balance -= applied;
          credit -= applied;
        }
        balanceById.set(o.id, balance);
      }
    }
  }

  const now = Date.now();
  let pendingCount = 0;
  let overdue = 0;
  let remaining = 0;
  for (const o of orderRows) {
    const paid = paidByOrder.get(o.id) ?? 0;
    const balance = balanceById.get(o.id) ?? Math.max(0, (o.total ?? 0) - paid);
    if (balance <= 0.01) continue;
    const days = Math.floor((now - new Date(o.updated_at as string).getTime()) / (24 * 60 * 60 * 1000));
    const threshold = o.customer_id ? thresholdById.get(o.customer_id) ?? 30 : 30;
    if (days > threshold) overdue += balance;
    else {
      pendingCount += 1;
      remaining += balance;
    }
  }

  const received = await monthToDateConfirmedPayments(supabase, opts.collectedBy);
  return { pendingCount, received, overdue, remaining };
}

// Delivered-order count and confirmed-payments total for an arbitrary
// [from, to] date range — feeds Sales' adjustable-date orders/payments
// widgets (§Sales: "widgets of orders and payments received, adjustable
// with date").
export async function countOrdersInRange(
  supabase: SupabaseClient,
  opts: { from: Date; to: Date; salesmanId?: string }
): Promise<number> {
  const start = new Date(opts.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(opts.to);
  end.setHours(23, 59, 59, 999);
  let q = supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .gte("created_at", start.toISOString())
    .lte("created_at", end.toISOString());
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export async function paymentsReceivedInRange(
  supabase: SupabaseClient,
  opts: { from: Date; to: Date; collectedBy?: string }
): Promise<number> {
  const start = new Date(opts.from);
  start.setHours(0, 0, 0, 0);
  const end = new Date(opts.to);
  end.setHours(23, 59, 59, 999);
  let q = supabase
    .from("payments")
    .select("amount")
    .eq("status", "confirmed")
    .gte("created_at", start.toISOString())
    .lte("created_at", end.toISOString());
  if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((s, p) => s + p.amount, 0);
}

async function monthToDateConfirmedPayments(supabase: SupabaseClient, collectedBy?: string): Promise<number> {
  let q = supabase
    .from("payments")
    .select("amount")
    .eq("status", "confirmed")
    .gte("created_at", startOfMonthIso());
  if (collectedBy) q = q.eq("collector_id", collectedBy);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).reduce((s, p) => s + p.amount, 0);
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
// default, optional)". Revenue and units for this month's delivered orders,
// grouped either by product category or by individual product. Uses the
// picked qty when there is one, matching how invoices and every other sales
// figure in the app are computed.
export async function fetchSalesByCategory(
  supabase: SupabaseClient,
  opts: { groupBy?: "category" | "product"; salesmanId?: string; limit?: number } = {}
): Promise<CategorySale[]> {
  let orderQ = supabase
    .from("orders")
    .select("id")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", startOfMonthIso());
  if (opts.salesmanId) orderQ = orderQ.eq("salesman_id", opts.salesmanId);
  const { data: orders, error } = await orderQ;
  if (error) throw error;
  const orderIds = (orders ?? []).map((o) => o.id);
  if (orderIds.length === 0) return [];

  const { data: items } = await supabase
    .from("order_items_safe")
    .select("product_id, sku, description, unit_price, ordered_qty, picked_qty")
    .in("order_id", orderIds);
  const rows = items ?? [];
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
        ? it.description || it.sku || "Unknown"
        : categoryByProduct.get(it.product_id) ?? "Uncategorized";
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
export async function fetchExpenseBreakdown(_supabase: SupabaseClient): Promise<{
  slices: ExpenseSlice[];
  total: number;
}> {
  const res = await fetch("/api/expenses");
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? "Failed to load expenses");
  const monthStart = startOfMonthIso().slice(0, 10);
  const data: { type: string; category: string | null; amount: number; date: string }[] = (
    json.expenses ?? []
  ).filter((e: { date: string }) => e.date >= monthStart);

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
