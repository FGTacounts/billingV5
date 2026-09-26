import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Product } from "@/lib/types/db";
import { fetchAllPages } from "@/lib/paging";

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
    stock_group_id: row.stock_group_id ?? null,
  };
}

const BASE_MANAGER_COLS =
  'id, sku, description, price, cost, default_qty, barcode, rack_location, is_active, stock_on_hand, "Product_category"';
// The override columns are cost figures, so they join the Manager list only —
// a Salesman session must never receive them, same rule as cost/stock_on_hand.
// stock_group_id is not a cost figure: whoever may see the stock may see
// which other SKUs it is shared with.
const MANAGER_COLS = `${BASE_MANAGER_COLS}, vac_override, vac_china_override, stock_arrival_date, stock_holding_days_override, stock_group_id`;
// Stock is included: a salesman needs to know whether there is any before
// promising it, and the warehouse works from it. Cost and the override figures
// are the manager-only ones, and they stay out.
const BASE_RESTRICTED_COLS =
  'id, sku, description, price, default_qty, barcode, rack_location, is_active, stock_on_hand, "Product_category"';
const RESTRICTED_COLS = `${BASE_RESTRICTED_COLS}, stock_group_id`;

export async function fetchProductsServer(
  admin: SupabaseClient,
  opts: {
    isManager: boolean;
    activeOnly?: boolean;
    search?: string;
    limit?: number;
    // Only the products sharing this stock group — the detail and edit
    // sheets ask for a product's shelf-mates this way.
    stockGroupId?: string;
  } = { isManager: false }
): Promise<Product[]> {
  // A fresh query each time it is called: paging asks for one per page.
  // `sku` then `id`, so the order is unique and no row can sit on two pages
  // or fall between them.
  const build = (cols: string) => {
    let q = admin.from("products").select(cols).order("sku").order("id");
    if (opts.activeOnly !== false) q = q.eq("is_active", true);
    if (opts.search) {
      // Quoted, because PostgREST reads `(`, `)` and `,` in an or() filter as
      // its own syntax: searching "GBA (white glove)" found nothing, so the
      // six SKUs with brackets could not be added to an order by their code.
      const term = `"%${opts.search.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}%"`;
      q = q.or(`sku.ilike.${term},description.ilike.${term},barcode.ilike.${term}`);
    }
    if (opts.stockGroupId) q = q.eq("stock_group_id", opts.stockGroupId);
    return q;
  };

  const run = async (cols: string): Promise<{ data: any[] | null; error: unknown }> => {
    // The first screenful is asked for on its own so a thousand-row
    // catalogue does not stand between the user and the page. One request,
    // deliberately short.
    if (opts.limit) return build(cols).limit(opts.limit);
    // Everything else is the whole list, and one request answers with at most
    // 1,000 rows without saying so (lib/paging.ts). There are more active
    // products than that, so it is read a page at a time.
    try {
      const data = await fetchAllPages<any>((from, to) => build(cols).range(from, to), { keyOf: (row) => row.id });
      return { data, error: null };
    } catch (error) {
      return { data: null, error };
    }
  };

  const cols = opts.isManager ? MANAGER_COLS : RESTRICTED_COLS;
  const { data, error } = await run(cols);
  if (!error) return (data ?? []).map(productFromRow);

  // The override columns don't exist until
  // scratchpad/product-manual-fields-migration.sql is run, and
  // stock_group_id not until RUN-ME-18-shared-stock.sql. Fall back to the
  // column set that has always been there so a missing column degrades to
  // "no overrides / no shared stock yet" rather than breaking every product
  // fetch app-wide. A group filter cannot be honoured without the column.
  if (opts.stockGroupId) throw error;
  const retry = await run(opts.isManager ? BASE_MANAGER_COLS : BASE_RESTRICTED_COLS);
  if (retry.error) throw retry.error;
  return (retry.data ?? []).map(productFromRow);
}
