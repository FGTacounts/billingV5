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

// Logs a GRN (goods received) entry and adds the received qty to
// stock_on_hand — the stock-replenishment counterpart to GRV's return path.
export async function logPurchase(
  supabase: SupabaseClient,
  input: { product_id: string; qty: number; grn_date: string; total_cost: number }
): Promise<void> {
  const { error: insertErr } = await supabase.from("purchases").insert(input);
  if (insertErr) throw insertErr;

  const { data: product, error: fetchErr } = await supabase
    .from("products")
    .select("stock_on_hand")
    .eq("id", input.product_id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;

  const { error: updateErr } = await supabase
    .from("products")
    .update({ stock_on_hand: (product?.stock_on_hand ?? 0) + input.qty })
    .eq("id", input.product_id);
  if (updateErr) throw updateErr;
}
