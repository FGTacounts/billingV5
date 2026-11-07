import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Combos (scratchpad/RUN-ME-39): a product sold as one of each of several
// other products. Its stock is the lowest of its parts', kept up to date by
// the database, and moving a combo's figure moves every part by the same
// amount — that is how a sale or a return of a combo reaches its parts.
//
// So nothing may set a combo's figure by hand: a stale number typed into a
// form or carried in a spreadsheet would be read as a sale or a delivery of
// that many sets. The writers that take a figure from a person (product
// Save, the stock route, the import) ask this first and leave combos alone.

/** Postgres/PostgREST saying the table is not there — RUN-ME-39 not run. */
export function comboTableMissing(message: string | undefined): boolean {
  return Boolean(message && message.includes("product_combo_parts"));
}

/** Every product that is a combo. Empty until RUN-ME-39 is run. */
export async function fetchComboIds(admin: SupabaseClient, ids?: string[]): Promise<Set<string>> {
  let q = admin.from("product_combo_parts").select("combo_id");
  if (ids) {
    if (ids.length === 0) return new Set();
    q = q.in("combo_id", ids);
  }
  const { data, error } = await q;
  if (error) {
    if (comboTableMissing(error.message)) return new Set();
    throw new Error(error.message);
  }
  return new Set((data ?? []).map((r) => r.combo_id as string));
}

export async function isCombo(admin: SupabaseClient, productId: string): Promise<boolean> {
  return (await fetchComboIds(admin, [productId])).has(productId);
}
