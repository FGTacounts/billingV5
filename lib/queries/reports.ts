import type { SupabaseClient } from "@supabase/supabase-js";
import { billingDateColumn } from "@/lib/billingDate";
import { BILLED_STATUSES } from "@/lib/billedStatuses";
import { localDateKey, monthBounds } from "@/lib/queries/dashboard";
import { fetchAllPages, fetchAllForIds } from "@/lib/paging";

export interface BalanceSheet {
  monthlySales: number;
  cogs: number;
  monthlyExpense: number;
  provision: number;
  profit: number;
  percentage: number;
}

// Mirrors the "BALANCE SHEET" tab layout in the reference V5.0 Reports
// workbook: Monthly Sales / COGS / Monthly Expense / Provision / Profit-Loss
// / Percentage. Manager-only (needs unit_cost). Sales come straight from
// orders.subtotal (stored directly now); COGS still needs item-level
// unit_cost since that's not aggregated onto the order.
// `period` is the window Reports' picker chose; left out, this month — what
// the Reports board and every other caller has always had.
export async function fetchBalanceSheet(
  supabase: SupabaseClient,
  period: { from: Date; to: Date } = monthBounds()
): Promise<BalanceSheet> {
  const billed = await billingDateColumn(supabase);
  // Paged: a year's billed orders run past the 1,000 rows one request
  // returns, and the total would stop short without saying so.
  const orderRows = await fetchAllPages<{ id: string; subtotal: number | null }>(
    (from, to) =>
      supabase
        .from("orders")
        .select("id, subtotal")
        .in("status", BILLED_STATUSES)
        .gte(billed, period.from.toISOString())
        .lte(billed, period.to.toISOString())
        .order("id")
        .range(from, to) as never,
    { keyOf: (o) => o.id }
  );
  const monthlySales = orderRows.reduce((s, o) => s + (o.subtotal ?? 0), 0);

  // Every line of those orders, cut into chunks short enough for a URL and
  // each paged in full (it used to be one unpaged request for the month).
  type CostLine = { id: string; unit_cost: number | null; ordered_qty: number; picked_qty: number | null };
  const items = await fetchAllForIds<CostLine>(
    orderRows.map((o) => o.id),
    (chunk, from, to) =>
      supabase
        .from("order_items_safe")
        .select("id, unit_cost, ordered_qty, picked_qty")
        .in("order_id", chunk)
        .order("id")
        .range(from, to) as never,
    { keyOf: (it) => it.id }
  );
  const cogs = items.reduce((s, it) => s + (it.unit_cost ?? 0) * (it.picked_qty ?? it.ordered_qty), 0);

  // Routed through /api/expenses (service-role, Manager-gated) — the
  // `expenses` RLS policy still references the old `users.auth_id` column
  // and 400s on every anon-key query; see app/api/expenses/route.ts.
  const expensesRes = await fetch("/api/expenses");
  const expensesJson = await expensesRes.json();
  // The period's ends as calendar days here. Slicing the ISO instant gave the
  // last day of the month before (local midnight is 20:00 UTC the day before
  // in Dubai), so a month's expenses took in the previous month's last day.
  const firstDay = localDateKey(period.from);
  const lastDay = localDateKey(period.to);
  const monthlyExpense = ((expensesJson.expenses ?? []) as { amount: number; date: string }[])
    .filter((e) => e.date >= firstDay && e.date <= lastDay)
    .reduce((s, e) => s + e.amount, 0);

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const provisionRate = settings?.vat_rate ?? 0.05;

  const provision = monthlySales * provisionRate;
  const profit = monthlySales - cogs - monthlyExpense - provision;
  const percentage = monthlySales > 0 ? profit / monthlySales : 0;

  return { monthlySales, cogs, monthlyExpense, provision, profit, percentage };
}

export interface StockSnapshotRow {
  sku: string;
  name: string;
  stockOnHand: number;
  price: number;
  value: number;
}

// A point-in-time stock snapshot — there's no purchase/GRN history with
// dates in the confirmed schema, so this can't reconstruct true stock
// movement/aging over time; it's current SOH valued at current price.
export async function fetchStockSnapshot(supabase: SupabaseClient): Promise<StockSnapshotRow[]> {
  const { data } = await supabase
    // products_safe does not exist in this database, and the product name
    // is held in `description`.
    .from("products")
    .select("sku, description, stock_on_hand, price")
    .order("sku");
  return (data ?? []).map((p) => ({
    sku: p.sku,
    name: p.description,
    stockOnHand: p.stock_on_hand ?? 0,
    price: p.price,
    value: (p.stock_on_hand ?? 0) * p.price,
  }));
}
