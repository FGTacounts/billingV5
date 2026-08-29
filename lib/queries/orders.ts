import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  Order,
  OrderItem,
  OrderStatus,
  Product,
  Customer,
  AppUser,
} from "@/lib/types/db";

export interface OrderRow extends Order {
  customer: Pick<
    Customer,
    "id" | "code" | "name" | "district" | "address" | "vat_number" | "overdue_threshold_days"
  > | null;
  salesman: Pick<AppUser, "id" | "full_name" | "phone"> | null;
}

const ORDER_SELECT =
  "id, status, customer_id, salesman_id, new_customer_note, warehouse_note, manager_note, salesman_note, invoice_number, po_number, rejected_at, total, subtotal, vat_amount, created_at, updated_at";

// `phone` is not on every database yet. When it is absent the salesman's
// number is left off the invoice rather than the whole order fetch failing.
//
// Remembered after the first refusal: every list of orders asks for salesmen,
// so without this the app sends a request it already knows will fail each
// time, and pays for a second one to recover from it.
let salesmanPhoneMissing = false;

async function fetchSalesmen(supabase: SupabaseClient, ids: string[]): Promise<any[]> {
  if (!ids.length) return [];
  if (!salesmanPhoneMissing) {
    const { data, error } = await supabase.from("users").select("id, full_name, phone").in("id", ids);
    if (!error) return data ?? [];
    salesmanPhoneMissing = true;
  }
  const { data: fallback } = await supabase.from("users").select("id, full_name").in("id", ids);
  return fallback ?? [];
}

// Joined manually (rather than PostgREST embed hints) since we don't have
// confirmed FK constraint names to disambiguate — see plan doc on schema
// probing limits.
async function attachRelations(
  supabase: SupabaseClient,
  rows: Order[]
): Promise<OrderRow[]> {
  const customerIds = [...new Set(rows.map((r) => r.customer_id).filter(Boolean))] as string[];
  const salesmanIds = [...new Set(rows.map((r) => r.salesman_id).filter(Boolean))] as string[];

  const [{ data: customers }, salesmen] = await Promise.all([
    customerIds.length
      ? supabase
          .from("customers")
          .select("id, code, name, district, address, vat_number, overdue_threshold_days")
          .in("id", customerIds)
      : Promise.resolve({ data: [] as any[] }),
    fetchSalesmen(supabase, salesmanIds),
  ]);

  const custById = new Map((customers ?? []).map((c: any) => [c.id, c]));
  const salesById = new Map((salesmen ?? []).map((s: any) => [s.id, s]));

  return rows.map((r) => ({
    ...r,
    customer: r.customer_id ? custById.get(r.customer_id) ?? null : null,
    salesman: r.salesman_id ? salesById.get(r.salesman_id) ?? null : null,
  }));
}

// Manager can see every order; Salesman/Warehouse are limited by RLS to
// their own/assigned rows regardless of the filters passed here — this is
// belt-and-suspenders, not the actual access control.
export async function fetchOrders(
  supabase: SupabaseClient,
  opts: {
    status?: OrderStatus[];
    excludeStatus?: OrderStatus[];
    salesmanId?: string;
    customerId?: string;
    limit?: number;
  } = {}
): Promise<OrderRow[]> {
  let q = supabase
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false });

  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.excludeStatus?.length) q = q.not("status", "in", `(${opts.excludeStatus.join(",")})`);
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  if (opts.customerId) q = q.eq("customer_id", opts.customerId);
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await q;
  if (error) throw error;
  return attachRelations(supabase, (data as Order[]) ?? []);
}

// Cheap count-only query (no row fetch) for header stats that need a total
// across statuses the bounded WIP fetch above no longer includes.
export async function countOrders(
  supabase: SupabaseClient,
  opts: { status?: OrderStatus[]; salesmanId?: string } = {}
): Promise<number> {
  let q = supabase.from("orders").select("id", { count: "exact", head: true });
  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

export interface OrderCursor {
  createdAt: string;
  id: string;
}

export interface OrderPage {
  rows: OrderRow[];
  nextCursor: OrderCursor | null;
}

// Real keyset pagination (§0.4/§0.7 — the v1 Sheets bug was exactly "load
// everything, get slow under load"), used for the unbounded historical
// buckets (Manager's Delivered list, Salesman/Warehouse's Past Orders) —
// the live pipeline buckets (Pending/Waiting/Picking/…) stay on the
// full-fetch fetchOrders() above since WIP is naturally small and those
// views need cross-bucket counts, not a single page.
export async function fetchOrdersPage(
  supabase: SupabaseClient,
  opts: {
    status?: OrderStatus[];
    excludeStatus?: OrderStatus[];
    salesmanId?: string;
    pageSize?: number;
    cursor?: OrderCursor | null;
  } = {}
): Promise<OrderPage> {
  const pageSize = opts.pageSize ?? 25;
  let q = supabase
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.excludeStatus?.length) q = q.not("status", "in", `(${opts.excludeStatus.join(",")})`);
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  if (opts.cursor) {
    q = q.or(
      `created_at.lt.${opts.cursor.createdAt},and(created_at.eq.${opts.cursor.createdAt},id.lt.${opts.cursor.id})`
    );
  }

  const { data, error } = await q;
  if (error) throw error;
  const rows = (data as Order[]) ?? [];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore
    ? { createdAt: pageRows[pageRows.length - 1].created_at, id: pageRows[pageRows.length - 1].id }
    : null;
  return { rows: await attachRelations(supabase, pageRows), nextCursor };
}

export async function fetchOrder(
  supabase: SupabaseClient,
  id: string
): Promise<OrderRow | null> {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_SELECT)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const [row] = await attachRelations(supabase, [data as Order]);
  return row;
}

export interface OrderItemRow extends OrderItem {
  // order_items.sku/description are their own snapshot columns (captured
  // at order-creation time) — that's the primary display source now.
  // `product` is fetched for rack_location (not on the snapshot) and price
  // (the list price, used to compute a per-line discount for the invoice —
  // §Orders PDF: "add a discount above the grand total" — since order_items
  // only stores the actually-charged unit_price, not what was discounted
  // off). A lookup failure (e.g. broken RLS on the raw products table — see
  // the pending security-fix SQL) degrades to no rack/discount shown, not a
  // broken order screen.
  product: Pick<Product, "id" | "rack_location" | "price"> | null;
}

// order_items_safe exists and carries everything except rack_location —
// no products_safe view anymore (removed from the live schema).
export async function fetchOrderItems(
  supabase: SupabaseClient,
  orderId: string
): Promise<OrderItemRow[]> {
  const { data: items, error } = await supabase
    .from("order_items_safe")
    .select("id, order_id, product_id, sku, description, unit_price, unit_cost, ordered_qty, picked_qty, picked_by_id, picked_at")
    .eq("order_id", orderId);
  if (error) throw error;
  const rows = (items as OrderItem[]) ?? [];
  if (rows.length === 0) return [];

  const productIds = [...new Set(rows.map((r) => r.product_id))];
  const byId = new Map<string, Pick<Product, "id" | "rack_location" | "price">>();
  try {
    const { data: products, error: pErr } = await supabase
      .from("products")
      .select("id, rack_location, price")
      .in("id", productIds);
    if (pErr) throw pErr;
    for (const p of products ?? []) byId.set(p.id, p as any);
  } catch {
    // Rack lookup is a nice-to-have enrichment — an RLS failure here
    // shouldn't take down the whole order screen.
  }

  return rows.map((r) => ({ ...r, product: byId.get(r.product_id) ?? null }));
}

export async function updateOrderStatus(
  supabase: SupabaseClient,
  orderId: string,
  status: OrderStatus,
  extra: Partial<Order> = {}
) {
  const { error } = await supabase
    .from("orders")
    .update({ status, ...extra })
    .eq("id", orderId);
  if (error) throw error;
}

// picked_qty updates go through /api/orders/update-picked-qty (service-role)
// — order_items carries unit_cost, which RLS can only restrict per-row, not
// per-column, so Warehouse's session can't hold direct table privileges on
// it once the RLS lockdown (see security fix) is applied.

// ---- Lifecycle transitions (§6) ----
// Each writes order_status_log (a simple who/when audit trail — it has no
// status column of its own, see plan doc) in addition to orders.status.

async function logStatus(supabase: SupabaseClient, orderId: string, actorId: string) {
  await supabase
    .from("order_status_log")
    .insert({ order_id: orderId, changed_by: actorId, changed_at: new Date().toISOString() });
}

export async function notify(
  supabase: SupabaseClient,
  userId: string,
  type: string,
  title: string,
  body?: string
) {
  await supabase.from("notifications").insert({ user_id: userId, type, title, body, is_read: false });
}

export async function sendDraft(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "pending");
  await logStatus(supabase, orderId, actorId);
}

export async function acceptOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "waiting");
  await logStatus(supabase, orderId, actorId);
}

export async function rejectOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "rejected", { rejected_at: new Date().toISOString() });
  await logStatus(supabase, orderId, actorId);
}

export async function resubmitOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "pending", { rejected_at: null });
  await logStatus(supabase, orderId, actorId);
}

export async function startPicking(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "picking");
  await logStatus(supabase, orderId, actorId);
}

export async function markPacked(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "packed");
  await logStatus(supabase, orderId, actorId);
}

export async function requestEdit(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "edit_requested");
  await logStatus(supabase, orderId, actorId);
}

export async function denyEditRequest(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "approved");
  await logStatus(supabase, orderId, actorId);
}

export async function startDelivering(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "delivering");
  await logStatus(supabase, orderId, actorId);
}

export async function confirmDelivery(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "delivered");
  await logStatus(supabase, orderId, actorId);
}

export async function cancelOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "cancelled");
  await logStatus(supabase, orderId, actorId);
}

// ---- Order editing ----
// Order/order-item creation goes through /api/orders/create (service-role),
// not a client insert here — unit_cost has to be snapshotted from the real
// products.cost, which a Salesman/Warehouse session can't read (RLS masks
// it via products_safe). See that route for why.

export const REJECTED_TTL_DAYS = 30;

export function daysUntilPurge(rejectedAt: string | null): number | null {
  if (!rejectedAt) return null;
  const rejected = new Date(rejectedAt).getTime();
  const purgeAt = rejected + REJECTED_TTL_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, Math.ceil((purgeAt - Date.now()) / (24 * 60 * 60 * 1000)));
}
