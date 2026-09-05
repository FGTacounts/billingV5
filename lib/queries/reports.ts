import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCountedStatuses } from "@/lib/reportStage";

function startOfMonthIso(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

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
export async function fetchBalanceSheet(supabase: SupabaseClient): Promise<BalanceSheet> {
  const start = startOfMonthIso();
  const { data: orders } = await supabase
    .from("orders")
    .select("id, subtotal")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", start);
  const orderRows = orders ?? [];
  const monthlySales = orderRows.reduce((s, o) => s + (o.subtotal ?? 0), 0);

  let cogs = 0;
  const orderIds = orderRows.map((o) => o.id);
  if (orderIds.length) {
    const { data: items } = await supabase
      .from("order_items_safe")
      .select("unit_cost, ordered_qty, picked_qty")
      .in("order_id", orderIds);
    cogs = (items ?? []).reduce(
      (s, it) => s + (it.unit_cost ?? 0) * (it.picked_qty ?? it.ordered_qty),
      0
    );
  }

  // Routed through /api/expenses (service-role, Manager-gated) — the
  // `expenses` RLS policy still references the old `users.auth_id` column
  // and 400s on every anon-key query; see app/api/expenses/route.ts.
  const expensesRes = await fetch("/api/expenses");
  const expensesJson = await expensesRes.json();
  const monthStart = start.slice(0, 10);
  const monthlyExpense = ((expensesJson.expenses ?? []) as { amount: number; date: string }[])
    .filter((e) => e.date >= monthStart)
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
