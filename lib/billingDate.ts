import type { SupabaseClient } from "@supabase/supabase-js";

// The date an order counts on — sales, aging, statements, the invoice itself.
//
// It used to be `orders.updated_at`, which the database re-stamps on EVERY
// update: correcting a note moved the sale to today, and one bulk update on
// 2026-09-04 moved a year of sales into that morning. RUN-ME-27 adds
// `orders.billed_at`, stamped only when the status changes and editable by a
// manager (a date set by hand stays put).
//
// Until RUN-ME-27 has been run the column is not there, and PostgREST refuses
// a whole request over one unknown column. So every reader asks here which
// column to use, and selects it under the one name `billed_at` either way:
//
//   const col = await billingDateColumn(supabase);
//   supabase.from("orders").select(`id, total, ${billedAtSelect(col)}`).gte(col, from)
//   row.billed_at   // always present
//
// Billing/BillingDate.swift on the phone is the same helper; change both.

export type BillingDateColumn = "billed_at" | "updated_at";

let known: BillingDateColumn | null = null;
let missingSince = 0;
// A server instance outlives the moment the owner runs the SQL, so "not
// there" is re-checked now and then. "There" is never re-checked.
const RECHECK_MISSING_MS = 5 * 60 * 1000;

export async function billingDateColumn(supabase: SupabaseClient): Promise<BillingDateColumn> {
  if (known === "billed_at") return known;
  if (known === "updated_at" && Date.now() - missingSince < RECHECK_MISSING_MS) return known;
  const { error } = await supabase.from("orders").select("billed_at").limit(1);
  if (!error) {
    known = "billed_at";
  } else if (error.code === "42703") {
    known = "updated_at";
    missingSince = Date.now();
  } else {
    // Not an answer about the column (offline, signed out). Behave as before
    // for this one call and ask again next time.
    return "updated_at";
  }
  return known;
}

/** The select fragment that always yields a `billed_at` key. */
export function billedAtSelect(col: BillingDateColumn): string {
  return col === "billed_at" ? "billed_at" : "billed_at:updated_at";
}
