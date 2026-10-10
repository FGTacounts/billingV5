import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function fetchPurchases(supabase: SupabaseClient, limit = 100): Promise<PurchaseRow[]> {
  const { data, error } = await supabase
    .from("purchases")
    .select("id, product_id, qty, grn_date, total_cost")
    .order("grn_date", { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data as Purchase[]) ?? [];
  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((r) => r.product_id))];
  // products_safe does not exist in this database, and the name is held in
  // `description`. Cost is not selected, so this stays readable to every role.
  const { data: products } = await supabase.from("products").select("id, sku, description").in("id", productIds);
  const byId = new Map((products ?? []).map((p) => [p.id, p]));

  return rows.map((r) => ({ ...r, sku: byId.get(r.product_id)?.sku ?? null, name: byId.get(r.product_id)?.description ?? null }));
}
