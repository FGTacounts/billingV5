import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/lib/types/db";

// Shared by /api/products (client-facing CRUD) and the server-side export
// routes (Excel/PDF) that also need product rows without an extra HTTP hop
// through their own route. Single place doing the DB(description) <->
// app(name) mapping and the Manager-only cost/stock column masking, now
// that there's no products_safe view to do it for us.
export function productFromRow(row: any): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.description ?? "",
    price: row.price,
    cost: row.cost ?? null,
    default_qty: row.default_qty,
    barcode: row.barcode,
    rack_location: row.rack_location,
    is_active: row.is_active,
    stock_on_hand: row.stock_on_hand ?? null,
    category: row.Product_category ?? null,
    // Manager-entered overrides for the four derived figures. Absent from
    // the row entirely for a non-Manager session (they're cost data), and
    // absent for everyone until the migration runs.
    vac_override: row.vac_override ?? null,
    vac_china_override: row.vac_china_override ?? null,
    stock_arrival_date: row.stock_arrival_date ?? null,
    stock_holding_days_override: row.stock_holding_days_override ?? null,
  };
}

const BASE_MANAGER_COLS =
  'id, sku, description, price, cost, default_qty, barcode, rack_location, is_active, stock_on_hand, "Product_category"';
// The override columns are cost figures, so they join the Manager list only —
// a Salesman session must never receive them, same rule as cost/stock_on_hand.
const MANAGER_COLS = `${BASE_MANAGER_COLS}, vac_override, vac_china_override, stock_arrival_date, stock_holding_days_override`;
// Stock is included: a salesman needs to know whether there is any before
// promising it, and the warehouse works from it. Cost and the override figures
// are the manager-only ones, and they stay out.
const RESTRICTED_COLS =
  'id, sku, description, price, default_qty, barcode, rack_location, is_active, stock_on_hand, "Product_category"';

export async function fetchProductsServer(
  admin: SupabaseClient,
  opts: { isManager: boolean; activeOnly?: boolean; search?: string } = { isManager: false }
): Promise<Product[]> {
  const run = async (cols: string) => {
    let q = admin.from("products").select(cols).order("sku");
    if (opts.activeOnly !== false) q = q.eq("is_active", true);
    if (opts.search) {
      q = q.or(`sku.ilike.%${opts.search}%,description.ilike.%${opts.search}%,barcode.ilike.%${opts.search}%`);
    }
    return q;
  };

  const cols = opts.isManager ? MANAGER_COLS : RESTRICTED_COLS;
  const { data, error } = await run(cols);
  if (!error) return (data ?? []).map(productFromRow);

  // The override columns don't exist until
  // scratchpad/product-manual-fields-migration.sql is run. Fall back to the
  // column set that has always been there so a missing column degrades to
  // "no overrides yet" rather than breaking every product fetch app-wide.
  if (!opts.isManager) throw error;
  const retry = await run(BASE_MANAGER_COLS);
  if (retry.error) throw retry.error;
  return (retry.data ?? []).map(productFromRow);
}
