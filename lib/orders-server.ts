import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { subtotal as calcSubtotal, vat as calcVat, total as calcTotal, FALLBACK_VAT_RATE } from "@/lib/money";
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
  await supabase
    .from("orders")
    .update({
      subtotal: calcSubtotal(rows),
      vat_amount: calcVat(rows, rate),
      total: calcTotal(rows, rate),
    })
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
