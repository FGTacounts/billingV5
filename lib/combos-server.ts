import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { t } from "@/lib/i18n";

// Combos (scratchpad/RUN-ME-39): a product sold as one of each of several
// other products. A combo can be sold under several SKUs — link them as
// shared stock and they are one combo shelf. Its stock is the lowest of its
// parts', kept up to date by the database, and moving the figure of ANY SKU
// on a combo shelf moves every part by the same amount — that is how a sale
// or a return of a combo reaches its parts.
//
// So nothing may set such a figure by hand: a stale number typed into a form
// or carried in a spreadsheet would be read as a sale or a delivery of that
// many sets. The writers that take a figure from a person (product Save, the
// stock route, the import) ask this first and leave combo shelves alone.

/** Postgres/PostgREST saying the table is not there — RUN-ME-39 not run. */
export function comboTableMissing(message: string | undefined): boolean {
  return Boolean(message && message.includes("product_combo_parts"));
}

/**
 * The database's refusals (RUN-ME-39 raises them with a code at the start of
 * the message) as the sentence to show. Anything else comes back unchanged.
 */
export function comboRefusal(message: string): string {
  if (message.includes("COMBO_SAME_SHELF")) return t("products.comboCannotContainItself");
  if (message.includes("COMBO_IN_COMBO")) return t("products.comboPartIsComboGeneric");
  if (message.includes("COMBO_IS_PART")) return t("products.comboIsAPartGeneric");
  if (message.includes("COMBO_LINK")) return t("products.comboLinkRefused");
  if (comboTableMissing(message)) return t("products.comboNotEnabled");
  return message;
}

const CHUNK = 200;

/**
 * Every product on a combo shelf: each combo, and every SKU sharing stock
 * with one. Empty until RUN-ME-39 is run. With `ids`, only those of them.
 */
export async function fetchComboIds(admin: SupabaseClient, ids?: string[]): Promise<Set<string>> {
  if (ids && ids.length === 0) return new Set();
  const { data: links, error } = await admin.from("product_combo_parts").select("combo_id");
  if (error) {
    if (comboTableMissing(error.message)) return new Set();
    throw new Error(error.message);
  }
  const combos = [...new Set((links ?? []).map((r) => r.combo_id as string))];
  const found = new Set(combos);
  const groups = new Set<string>();
  for (let i = 0; i < combos.length; i += CHUNK) {
    const { data, error: e } = await admin
      .from("products")
      .select("stock_group_id")
      .in("id", combos.slice(i, i + CHUNK))
      .not("stock_group_id", "is", null);
    if (e) throw new Error(e.message);
    for (const r of data ?? []) groups.add(r.stock_group_id as string);
  }
  const groupList = [...groups];
  for (let i = 0; i < groupList.length; i += CHUNK) {
    const { data, error: e } = await admin
      .from("products")
      .select("id")
      .in("stock_group_id", groupList.slice(i, i + CHUNK));
    if (e) throw new Error(e.message);
    for (const r of data ?? []) found.add(r.id as string);
  }
  if (!ids) return found;
  return new Set(ids.filter((id) => found.has(id)));
}

export async function isCombo(admin: SupabaseClient, productId: string): Promise<boolean> {
  return (await fetchComboIds(admin, [productId])).has(productId);
}

/** Every product on the same shelf as `productId`, itself included. */
export async function shelfMembers(
  admin: SupabaseClient,
  productId: string
): Promise<{ id: string; sku: string; stock_group_id: string | null }[]> {
  const { data: me, error } = await admin
    .from("products")
    .select("id, sku, stock_group_id")
    .eq("id", productId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!me) return [];
  if (!me.stock_group_id) return [me];
  const { data, error: e } = await admin
    .from("products")
    .select("id, sku, stock_group_id")
    .eq("stock_group_id", me.stock_group_id);
  if (e) throw new Error(e.message);
  return data ?? [];
}
