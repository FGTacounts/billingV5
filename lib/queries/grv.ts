import type { SupabaseClient } from "@supabase/supabase-js";
import type { GrvReturn, GrvItem, Customer } from "@/lib/types/db";

export interface GrvRow extends GrvReturn {
  customer: Pick<Customer, "id" | "name" | "code"> | null;
  totalValue: number;
}

export async function fetchGrvs(supabase: SupabaseClient): Promise<GrvRow[]> {
  const { data, error } = await supabase
    .from("grv_returns")
    .select("id, customer_id, submitted_by, status, approved_by, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  const rows = (data as GrvReturn[]) ?? [];
  if (rows.length === 0) return [];

  const [{ data: customers }, { data: items }] = await Promise.all([
    supabase.from("customers").select("id, name, code").in("id", [...new Set(rows.map((r) => r.customer_id))]),
    supabase.from("grv_items").select("grv_id, qty, unit_value").in("grv_id", rows.map((r) => r.id)),
  ]);
  const custById = new Map((customers ?? []).map((c) => [c.id, c]));
  const valueByGrv = new Map<string, number>();
  for (const it of items ?? []) {
    valueByGrv.set(it.grv_id, (valueByGrv.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
  }

  return rows.map((r) => ({
    ...r,
    customer: custById.get(r.customer_id) ?? null,
    totalValue: valueByGrv.get(r.id) ?? 0,
  }));
}

export async function fetchGrvItems(
  supabase: SupabaseClient,
  grvId: string
): Promise<(GrvItem & { sku?: string; name?: string })[]> {
  const { data, error } = await supabase
    .from("grv_items")
    .select("id, grv_id, product_id, qty, unit_value")
    .eq("grv_id", grvId);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const { data: products } = await supabase.from("products_safe").select("id, sku, name").in("id", productIds);
  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, sku: byId.get(r.product_id)?.sku, name: byId.get(r.product_id)?.name }));
}

export async function createGrv(
  supabase: SupabaseClient,
  customerId: string,
  submittedBy: string,
  items: { product_id: string; qty: number; unit_value: number }[]
): Promise<string> {
  const { data, error } = await supabase
    .from("grv_returns")
    .insert({ customer_id: customerId, submitted_by: submittedBy, status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  const { error: itemsErr } = await supabase
    .from("grv_items")
    .insert(items.map((it) => ({ grv_id: data.id, product_id: it.product_id, qty: it.qty, unit_value: it.unit_value })));
  if (itemsErr) throw itemsErr;
  return data.id as string;
}

// Sum of approved GRVs per customer (qty × unit_value, captured at
// submission time) — a credit note that reduces the customer's outstanding
// balance once approved. Consumed by aging.ts / dashboard.ts to apply
// against the customer's oldest invoices first, same order confirmed
// payments already age off.
export async function fetchApprovedGrvCreditByCustomer(
  supabase: SupabaseClient,
  customerIds?: string[]
): Promise<Map<string, number>> {
  let query = supabase.from("grv_returns").select("id, customer_id").eq("status", "approved");
  if (customerIds && customerIds.length) query = query.in("customer_id", customerIds);
  const { data: grvs, error } = await query;
  if (error) throw error;
  const rows = grvs ?? [];
  if (rows.length === 0) return new Map();

  const custByGrv = new Map(rows.map((g) => [g.id, g.customer_id as string]));
  const { data: items, error: itemsErr } = await supabase
    .from("grv_items")
    .select("grv_id, qty, unit_value")
    .in("grv_id", rows.map((g) => g.id));
  if (itemsErr) throw itemsErr;

  const creditByCustomer = new Map<string, number>();
  for (const it of items ?? []) {
    const custId = custByGrv.get(it.grv_id);
    if (!custId) continue;
    creditByCustomer.set(custId, (creditByCustomer.get(custId) ?? 0) + it.qty * it.unit_value);
  }
  return creditByCustomer;
}

// Approval restores stock_on_hand for every returned line, then folds the
// credited value into the customer's balance (see fetchApprovedGrvCreditByCustomer).
export async function approveGrv(supabase: SupabaseClient, grvId: string, approvedBy: string) {
  const { data: items, error } = await supabase
    .from("grv_items")
    .select("product_id, qty")
    .eq("grv_id", grvId);
  if (error) throw error;

  for (const it of items ?? []) {
    const { data: product } = await supabase
      .from("products")
      .select("stock_on_hand")
      .eq("id", it.product_id)
      .maybeSingle();
    if (!product) continue;
    await supabase
      .from("products")
      .update({ stock_on_hand: (product.stock_on_hand ?? 0) + it.qty })
      .eq("id", it.product_id);
  }

  const { error: updErr } = await supabase
    .from("grv_returns")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", grvId);
  if (updErr) throw updErr;
}
