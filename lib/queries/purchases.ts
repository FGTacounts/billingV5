import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllForIds, fetchAllPages } from "@/lib/paging";
import { localDateKey } from "@/lib/queries/dashboard";

export interface Purchase {
  id: string;
  product_id: string;
  qty: number;
  grn_date: string;
  total_cost: number;
}

export interface PurchaseRow extends Purchase {
  sku: string | null;
  name: string | null;
}

// The newest `limit` goods receipts, or — given a period (Reports' picker) —
// every receipt in it, a page at a time. A receipt belongs to the calendar
// day its grn_date falls on here; the database is asked for a day either side
// and the edges are settled on this clock, which holds whether grn_date is
// stored as a date or as an instant.
export async function fetchPurchases(
  supabase: SupabaseClient,
  limit = 100,
  period?: { from: Date; to: Date }
): Promise<PurchaseRow[]> {
  let rows: Purchase[];
  if (period) {
    const dayBefore = new Date(period.from.getTime() - 86_400_000);
    const dayAfter = new Date(period.to.getTime() + 86_400_000);
    const firstDay = localDateKey(period.from);
    const lastDay = localDateKey(period.to);
    rows = (
      await fetchAllPages<Purchase>(
        (from, to) =>
          supabase
            .from("purchases")
            .select("id, product_id, qty, grn_date, total_cost")
            .gte("grn_date", localDateKey(dayBefore))
            .lte("grn_date", localDateKey(dayAfter))
            .order("grn_date", { ascending: false })
            .order("id")
            .range(from, to) as never,
        { keyOf: (r) => r.id }
      )
    ).filter((r) => {
      const day = localDateKey(new Date(r.grn_date));
      return day >= firstDay && day <= lastDay;
    });
  } else {
    const { data, error } = await supabase
      .from("purchases")
      .select("id, product_id, qty, grn_date, total_cost")
      .order("grn_date", { ascending: false })
      .limit(limit);
    if (error) throw error;
    rows = (data as Purchase[]) ?? [];
  }
  if (rows.length === 0) return [];

  // products_safe does not exist in this database, and the name is held in
  // `description`. Cost is not selected, so this stays readable to every role.
  // Chunked: a year of receipts names more products than one URL holds.
  type ProductName = { id: string; sku: string | null; description: string | null };
  const products = await fetchAllForIds<ProductName>(
    rows.map((r) => r.product_id),
    (chunk, from, to) =>
      supabase.from("products").select("id, sku, description").in("id", chunk).order("id").range(from, to) as never
  );
  const byId = new Map(products.map((p) => [p.id, p]));

  return rows.map((r) => ({ ...r, sku: byId.get(r.product_id)?.sku ?? null, name: byId.get(r.product_id)?.description ?? null }));
}
