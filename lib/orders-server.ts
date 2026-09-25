import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subtotalFils, toAed, billed, FALLBACK_VAT_RATE } from "@/lib/money";
import { resolveVatRate } from "@/lib/queries/zones";

// Shared by the three routes that change what is on an order —
// update-item, add-item and remove-item. The recompute used to live inside
// update-item alone; a line added or taken off has to move the same three
// figures, and three copies of it is three chances for them to drift apart.

/**
 * Re-adds the order up from its lines and stores subtotal/vat_amount/total.
 *
 * The VAT rate is the customer's zone rate where there is one, falling back
 * to the app-wide rate — the same resolution the approval does, so a
 * pre-approval total and the billed total agree.
 *
 * subtotal/vat_amount/total are NOT NULL columns (default 0), so an order
 * with no lines left is written as zeroes rather than nulls.
 *
 * The order-wide discount (RUN-ME-28) comes off before VAT, as the database's
 * manager_edit_order does, so both routes to a total agree. Before RUN-ME-28
 * there is no discount column and the discount is 0.
 */
export async function recalcOrderTotals(
  supabase: SupabaseClient,
  orderId: string,
  customerId: string | null
): Promise<void> {
  const { data: allItems } = await supabase
    .from("order_items")
    .select("unit_price, ordered_qty, picked_qty")
    .eq("order_id", orderId);

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const fallbackRate = settings?.vat_rate ?? FALLBACK_VAT_RATE;

  let customerCountry: string | null = null;
  if (customerId) {
    const { data: cust } = await supabase.from("customers").select("country_code").eq("id", customerId).maybeSingle();
    customerCountry = cust?.country_code ?? null;
  }
  const rate = await resolveVatRate(supabase, customerCountry, fallbackRate);

  const rows = allItems ?? [];
  const discount = await orderDiscount(supabase, orderId);
  const net = Math.max(0, subtotalFils(rows) - Math.round(discount * 100));
  const { subtotal, vatAmount, total } = billed(toAed(net), rate);
  await supabase
    .from("orders")
    .update({ subtotal, vat_amount: vatAmount, total })
    .eq("id", orderId);
}

// Remembered after the first refusal, so a database without RUN-ME-19 does
// not pay for a write it already knows will be rejected on every edit.
let editedColumnsMissing = false;

/**
 * Records that somebody changed what is on this order, so the apps can show
 * the Edited pill beside the status.
 *
 * Best effort, and deliberately so: the columns only exist once
 * scratchpad/RUN-ME-19-order-edited-stamp.sql has been run, and a database
 * that has not had it must still be able to edit an order. Same degradation
 * as the override columns in lib/products-server.ts — a missing column means
 * "no stamp yet", never a failed edit.
 */
export async function stampEdited(
  supabase: SupabaseClient,
  orderId: string,
  userId: string
): Promise<boolean> {
  if (editedColumnsMissing) return false;
  const { error } = await supabase
    .from("orders")
    .update({ edited_at: new Date().toISOString(), edited_by: userId })
    .eq("id", orderId);
  if (error && /edited_(at|by)/.test(error.message ?? "")) editedColumnsMissing = true;
  return !error;
}

/** The order-wide discount in AED, or 0 before RUN-ME-28 has been run. */
export async function orderDiscount(supabase: SupabaseClient, orderId: string): Promise<number> {
  const { data, error } = await supabase.from("orders").select("discount_amount").eq("id", orderId).maybeSingle();
  if (error) return 0;
  return Number(data?.discount_amount) || 0;
}

/**
 * One change in a manager's edit — see manager_edit_order in
 * scratchpad/RUN-ME-28-manager-edits-any-order.sql for what each does.
 */
export type ManagerChange =
  | { op: "set"; id: string; qty?: number; unit_price?: number }
  | { op: "set"; product_id: string; qty: number; unit_price?: number }
  | { op: "remove"; id: string }
  | { op: "pick"; id: string; qty: number | null }
  | { op: "arrange"; ids: string[] };

export type ManagerEditResult =
  | { ok: true }
  | { ok: false; missing: true }
  | { ok: false; missing: false; message: string };

/**
 * A manager's change to an order, at any stage (owner, 2026-09-25): the lines,
 * the stock and the totals move together inside the database, or not at all.
 * Runs as the caller, so the function sees who they are.
 *
 * `missing` means RUN-ME-28 has not been run yet. The routes then fall back
 * to the rules they had before it, so nothing stops working in the meantime.
 */
export async function managerEditOrder(
  supabase: SupabaseClient,
  orderId: string,
  changes: ManagerChange[],
  discount?: number
): Promise<ManagerEditResult> {
  const { error } = await supabase.rpc("manager_edit_order", {
    p_order_id: orderId,
    p_changes: changes,
    p_discount: discount ?? null,
  });
  if (!error) return { ok: true };
  if (error.code === "PGRST202" || /manager_edit_order/.test(error.message ?? "")) {
    return { ok: false, missing: true };
  }
  return { ok: false, missing: false, message: error.message };
}
