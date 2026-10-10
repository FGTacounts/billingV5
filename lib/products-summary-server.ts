import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/lib/types/db";
import type { ProductSummary, TopSeller } from "@/lib/queries/products";
import { fetchProductsServer } from "@/lib/products-server";
import { fetchAllPages, fetchAllForIds } from "@/lib/paging";
import { billingDateColumn } from "@/lib/billingDate";
import { BILLED_STATUSES } from "@/lib/billedStatuses";
import { hasCost } from "@/lib/articleCost";
import { toFils, toAed } from "@/lib/money";

// The figures in the summary card at the top of Products (owner, 2026-10-10:
// "show the value of the products. most selling product this month and things
// like that"). Worked out here, under the admin key, because the stock value
// is every article's cost at once and a staff session may not read cost
// (docs/why-cost-prices-are-hidden.md). The route checks the caller is a
// manager before this is called.

const TOP_SELLERS = 5;

interface StockTotals {
  articles: number;
  inStock: number;
  outOfStock: number;
  units: number;
  costFils: number;
  priceFils: number;
  inStockNoCost: number;
}

/**
 * What is on the shelves, over the active articles — the ones the page lists.
 *
 * Articles sharing a stock group are one physical shelf sold under several
 * SKUs, and each of them carries the shelf's whole figure, so adding them up
 * row by row would count that stock once per SKU. A shelf is counted once
 * here, at the lowest cost and the lowest price among its SKUs: when the SKUs
 * disagree the stock is worth at least that much, and nobody has said which
 * SKU's figure is the shelf's.
 */
export function stockTotals(products: Pick<Product, "id" | "price" | "cost" | "stock_on_hand" | "stock_group_id">[]): StockTotals {
  const totals: StockTotals = {
    articles: products.length,
    inStock: 0,
    outOfStock: 0,
    units: 0,
    costFils: 0,
    priceFils: 0,
    inStockNoCost: 0,
  };
  const shelves = new Map<string, { units: number; costFils: number | null; priceFils: number }>();

  for (const p of products) {
    const units = Math.max(0, p.stock_on_hand ?? 0);
    if (units > 0) totals.inStock += 1;
    else totals.outOfStock += 1;
    if (units === 0) continue;

    const costFils = hasCost(p.cost) ? toFils(Number(p.cost)) : null;
    if (costFils === null) totals.inStockNoCost += 1;
    const priceFils = toFils(p.price ?? 0);

    if (!p.stock_group_id) {
      totals.units += units;
      totals.costFils += (costFils ?? 0) * units;
      totals.priceFils += priceFils * units;
      continue;
    }
    const shelf = shelves.get(p.stock_group_id);
    if (!shelf) {
      shelves.set(p.stock_group_id, { units, costFils, priceFils });
    } else {
      shelf.units = Math.max(shelf.units, units);
      if (costFils !== null) shelf.costFils = shelf.costFils === null ? costFils : Math.min(shelf.costFils, costFils);
      shelf.priceFils = Math.min(shelf.priceFils, priceFils);
    }
  }

  for (const shelf of shelves.values()) {
    totals.units += shelf.units;
    totals.costFils += (shelf.costFils ?? 0) * shelf.units;
    totals.priceFils += shelf.priceFils * shelf.units;
  }
  return totals;
}

interface SoldLine {
  id: string;
  product_id: string | null;
  sku: string | null;
  description: string | null;
  unit_price: number | null;
  ordered_qty: number | null;
  picked_qty: number | null;
}

// Every line of the orders billed in the window — the same orders, by the
// same billing date and the same statuses, that Sales and the Dashboard count.
async function soldLines(admin: SupabaseClient, from: string, to: string): Promise<SoldLine[]> {
  const billed = await billingDateColumn(admin);
  const orders = await fetchAllPages<{ id: string }>(
    (lo, hi) =>
      admin
        .from("orders")
        .select("id")
        .in("status", BILLED_STATUSES)
        .gte(billed, from)
        .lte(billed, to)
        .order("id")
        .range(lo, hi) as never,
    { keyOf: (o) => o.id }
  );
  return fetchAllForIds<SoldLine>(
    orders.map((o) => o.id),
    (chunk, lo, hi) =>
      admin
        .from("order_items")
        .select("id, product_id, sku, description, unit_price, ordered_qty, picked_qty")
        .in("order_id", chunk)
        .order("id")
        .range(lo, hi) as never,
    { keyOf: (it) => it.id }
  );
}

export async function fetchProductSummaryServer(
  admin: SupabaseClient,
  window: { from: string; to: string }
): Promise<ProductSummary> {
  const [products, lines] = await Promise.all([
    fetchProductsServer(admin, { isManager: true }),
    soldLines(admin, window.from, window.to),
  ]);

  const stock = stockTotals(products);
  const catalogue = new Map(products.map((p) => [p.id, p]));

  // Picked quantity when there is one, as on the invoice.
  const sold = new Map<string, { productId: string | null; sku: string; name: string; units: number; fils: number }>();
  let units = 0;
  let fils = 0;
  for (const it of lines) {
    const qty = it.picked_qty ?? it.ordered_qty ?? 0;
    const lineFils = Math.round(toFils(it.unit_price ?? 0) * qty);
    units += qty;
    fils += lineFils;
    const key = it.product_id ?? `sku:${it.sku ?? ""}`;
    let row = sold.get(key);
    if (!row) {
      // The article's name as it is now; what the invoice called it when the
      // article has since been made inactive or removed.
      const current = it.product_id ? catalogue.get(it.product_id) : undefined;
      row = {
        productId: it.product_id,
        sku: current?.sku ?? it.sku ?? "",
        name: current?.name ?? it.description ?? "",
        units: 0,
        fils: 0,
      };
      sold.set(key, row);
    }
    row.units += qty;
    row.fils += lineFils;
  }

  // "Most selling" is by pieces; the money breaks a tie.
  const top: TopSeller[] = [...sold.values()]
    .filter((r) => r.units > 0)
    .sort((a, b) => b.units - a.units || b.fils - a.fils || a.sku.localeCompare(b.sku))
    .slice(0, TOP_SELLERS)
    .map((r) => ({ productId: r.productId, sku: r.sku, name: r.name, units: r.units, value: toAed(r.fils) }));

  return {
    stock: {
      articles: stock.articles,
      inStock: stock.inStock,
      outOfStock: stock.outOfStock,
      units: stock.units,
      valueAtCost: toAed(stock.costFils),
      valueAtPrice: toAed(stock.priceFils),
      inStockNoCost: stock.inStockNoCost,
    },
    month: {
      units,
      value: toAed(fils),
      articlesSold: [...sold.values()].filter((r) => r.units > 0).length,
      top,
    },
  };
}
