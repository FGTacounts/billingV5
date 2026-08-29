import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/lib/types/db";
import { fetchCountedStatuses } from "@/lib/reportStage";

// Routed through /api/products (service-role) rather than a direct client
// query — there's no products_safe view anymore (removed from the live
// schema) and direct RLS-enforced writes against `products` are broken
// today (current_role_is() references a dropped column). The route does
// the role-based column masking that the view used to.
export async function fetchProducts(
  supabase: SupabaseClient,
  opts: { activeOnly?: boolean; search?: string } = {}
): Promise<Product[]> {
  const params = new URLSearchParams();
  if (opts.activeOnly === false) params.set("activeOnly", "false");
  if (opts.search) params.set("search", opts.search);
  const res = await fetch(`/api/products?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to load products");
  return data.products as Product[];
}

export async function createProduct(
  supabase: SupabaseClient,
  input: Partial<Product>
) {
  const res = await fetch("/api/products", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to create product");
  return { overridesDropped: Boolean(data.overridesDropped) };
}

export async function updateProduct(
  supabase: SupabaseClient,
  id: string,
  input: Partial<Product>
) {
  const res = await fetch("/api/products", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...input }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update product");
  return { overridesDropped: Boolean(data.overridesDropped) };
}

export interface ProductInsight {
  vac: number | null; // landing cost, from the most recent purchase (GRN)
  vacChina: number | null; // china cost (¥), pre-landing, most recent purchase
  sad: number | null; // days since that most recent GRN
  avgMonthlySold: number; // avg units sold/month over the lookback window
  sold90d: number; // raw units sold in the lookback window (delivered orders) — field name kept for the 90d default, actual window is whatever `days` was passed
  sale90d: number; // revenue in the lookback window (sum of unit_price * qty)
}

// Manager-only expanded-row figures (§1.7). Real underlying data (purchases,
// delivered order_items), not fabricated — SAD/VAC come from the most
// recent GRN per product; SHD (stock ÷ avg monthly sale) is left for the
// caller to compute once it also has stock_on_hand. `days` is the Sale/Sold
// lookback window (§Products: "Adjust View columns need date/time range
// adjustability, e.g. switch from 90 days to 30 days") — defaults to 90.
export async function fetchProductInsights(
  supabase: SupabaseClient,
  productIds: string[],
  days = 90
): Promise<Map<string, ProductInsight>> {
  const map = new Map<string, ProductInsight>();
  if (productIds.length === 0) return map;

  const { data: purchases } = await supabase
    .from("purchases")
    .select("product_id, china_cost, landing_cost, grn_date")
    .in("product_id", productIds)
    .order("grn_date", { ascending: false });
  const latestByProduct = new Map<string, { china: number | null; landing: number | null; grn: string }>();
  for (const p of purchases ?? []) {
    if (!latestByProduct.has(p.product_id)) {
      latestByProduct.set(p.product_id, { china: p.china_cost, landing: p.landing_cost, grn: p.grn_date });
    }
  }

  const windowStart = new Date();
  windowStart.setDate(windowStart.getDate() - days);
  const { data: recentOrders } = await supabase
    .from("orders")
    .select("id")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", windowStart.toISOString());
  const orderIds = (recentOrders ?? []).map((o) => o.id);

  const soldByProduct = new Map<string, number>();
  const revenueByProduct = new Map<string, number>();
  if (orderIds.length) {
    const { data: items } = await supabase
      .from("order_items_safe")
      .select("product_id, ordered_qty, picked_qty, order_id, unit_price")
      .in("order_id", orderIds)
      .in("product_id", productIds);
    for (const it of items ?? []) {
      const qty = it.picked_qty ?? it.ordered_qty ?? 0;
      soldByProduct.set(it.product_id, (soldByProduct.get(it.product_id) ?? 0) + qty);
      revenueByProduct.set(
        it.product_id,
        (revenueByProduct.get(it.product_id) ?? 0) + qty * (it.unit_price ?? 0)
      );
    }
  }

  const now = Date.now();
  const months = days / 30;
  for (const id of productIds) {
    const purchase = latestByProduct.get(id);
    const sad = purchase ? Math.floor((now - new Date(purchase.grn).getTime()) / (24 * 60 * 60 * 1000)) : null;
    map.set(id, {
      vac: purchase?.landing ?? null,
      vacChina: purchase?.china ?? null,
      sad,
      avgMonthlySold: (soldByProduct.get(id) ?? 0) / months,
      sold90d: soldByProduct.get(id) ?? 0,
      sale90d: revenueByProduct.get(id) ?? 0,
    });
  }
  return map;
}

export interface LastSoldPrice {
  price: number;
  date: string;
  customerName: string | null;
}

// §Products: "the product clicked should show what was the last time's
// price" — the most recent price this product was actually billed at,
// across any customer's approved/delivered order (distinct from the
// per-customer sticky price in customer_prices, which NewOrderSheet uses).
export async function fetchLastSoldPrice(
  supabase: SupabaseClient,
  productId: string
): Promise<LastSoldPrice | null> {
  const { data: items, error } = await supabase
    .from("order_items_safe")
    .select("unit_price, order_id")
    .eq("product_id", productId)
    .order("order_id", { ascending: false })
    .limit(20);
  if (error || !items || items.length === 0) return null;

  const orderIds = items.map((it) => it.order_id);
  const { data: orders } = await supabase
    .from("orders")
    .select("id, customer_id, updated_at, status")
    .in("id", orderIds)
    .in("status", ["approved", "delivered"])
    .order("updated_at", { ascending: false })
    .limit(1);
  const latest = orders?.[0];
  if (!latest) return null;
  const item = items.find((it) => it.order_id === latest.id);
  if (!item) return null;

  let customerName: string | null = null;
  if (latest.customer_id) {
    const { data: cust } = await supabase.from("customers").select("name").eq("id", latest.customer_id).maybeSingle();
    customerName = cust?.name ?? null;
  }

  return { price: item.unit_price, date: latest.updated_at, customerName };
}

// The four figures the Products screens show for VAC / VAC (China) / stock
// arrival days / stock holding days. Each is derived from purchase and sales
// history by default; a manager-entered override on the product wins when
// it's set. One place doing this so the list, the expanded row, the detail
// sheet and the GP calculation can't drift apart.
export interface ResolvedProductFigures {
  vac: number | null;
  vacChina: number | null;
  sad: number | null; // days since stock arrived
  shd: number | null; // stock holding days
  // Which of them the manager typed, for the "overridden" marker in the UI.
  overridden: { vac: boolean; vacChina: boolean; sad: boolean; shd: boolean };
}

function daysSince(isoDate: string): number {
  const ms = Date.now() - new Date(isoDate).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function resolveProductFigures(
  product: { stock_on_hand: number | null } & Partial<Product>,
  insight?: ProductInsight
): ResolvedProductFigures {
  const vacOverride = product.vac_override ?? null;
  const vacChinaOverride = product.vac_china_override ?? null;
  const arrival = product.stock_arrival_date ?? null;
  const shdOverride = product.stock_holding_days_override ?? null;

  // In DAYS. This was inconsistent before: the list and expanded row showed
  // stock ÷ avg-monthly-sold (a count of *months*) under a "days" label,
  // while the editor showed the same thing × 30. Days everywhere now, which
  // is what every label says and what a typed override means.
  //
  // Skipped when stock is zero or negative — "days of cover" is meaningless
  // for stock you don't have, and a negative reads as nonsense on screen.
  const derivedShd =
    insight && product.stock_on_hand != null && product.stock_on_hand > 0 && insight.avgMonthlySold > 0
      ? (product.stock_on_hand / insight.avgMonthlySold) * 30
      : null;

  return {
    vac: vacOverride ?? insight?.vac ?? null,
    vacChina: vacChinaOverride ?? insight?.vacChina ?? null,
    sad: arrival != null ? daysSince(arrival) : (insight?.sad ?? null),
    shd: shdOverride ?? derivedShd,
    overridden: {
      vac: vacOverride != null,
      vacChina: vacChinaOverride != null,
      sad: arrival != null,
      shd: shdOverride != null,
    },
  };
}
