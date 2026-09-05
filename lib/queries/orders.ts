import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidateOrderFacts } from "@/lib/queries/dashboard";
import { invalidateAging } from "@/lib/queries/aging";
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

// The trash columns arrive with RUN-ME-12. Until they do, every list behaves
// exactly as it did before — nothing is filtered and the Trash is empty —
// rather than every order query failing over a column that isn't there yet.
let trashColumnsMissing = false;

export function orderTrashSupported(): boolean {
  return !trashColumnsMissing;
}

// Runs a query that filters out deleted orders, and quietly runs it again
// without that filter on a database that has no such column.
async function withoutDeleted<R extends { error: { code?: string } | null }>(
  build: (filterDeleted: boolean) => PromiseLike<R>
): Promise<R> {
  if (!trashColumnsMissing) {
    const first = await build(true);
    if (!first.error) return first;
    if (first.error.code !== "42703") return first;
    trashColumnsMissing = true;
  }
  return build(false);
}

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
    // Revenue window, matched on `updated_at` — the same column every sales
    // figure is bucketed by (see saleValue/fetchSaleTrend), so a list built
    // with these agrees with the totals beside it.
    from?: Date;
    to?: Date;
  } = {}
): Promise<OrderRow[]> {
  let q = supabase
    .from("orders")
    .select(ORDER_SELECT)
    .order("created_at", { ascending: false });

  if (opts.status?.length) q = q.in("status", opts.status);
  if (opts.excludeStatus?.length) q = q.not("status", "in", `(${opts.excludeStatus.join(",")})`);
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);
  if (opts.from) q = q.gte("updated_at", opts.from.toISOString());
  if (opts.to) q = q.lte("updated_at", opts.to.toISOString());
  if (opts.customerId) q = q.eq("customer_id", opts.customerId);
  if (opts.limit) q = q.limit(opts.limit);

  const { data, error } = await withoutDeleted((filterDeleted) =>
    filterDeleted ? q.is("deleted_at", null) : q
  );
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
  const { count, error } = await withoutDeleted((filterDeleted) =>
    filterDeleted ? q.is("deleted_at", null) : q
  );
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

  const { data, error } = await withoutDeleted((filterDeleted) =>
    filterDeleted ? q.is("deleted_at", null) : q
  );
  if (error) throw error;
  const rows = (data as Order[]) ?? [];
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore
    ? { createdAt: pageRows[pageRows.length - 1].created_at, id: pageRows[pageRows.length - 1].id }
    : null;
  return { rows: await attachRelations(supabase, pageRows), nextCursor };
}

// The Trash in Orders (§Orders: "ability to delete orders… it should be in
// the trash can in the orders"). Deleted orders keep their invoice number and
// their history; they are simply out of every list and every total until
// somebody restores them or empties them out for good.
export interface TrashedOrderRow extends OrderRow {
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_from_status: string | null;
}

export async function fetchTrashedOrders(
  supabase: SupabaseClient,
  opts: { salesmanId?: string } = {}
): Promise<TrashedOrderRow[]> {
  if (trashColumnsMissing) return [];
  let q = supabase
    .from("orders")
    .select(`${ORDER_SELECT}, deleted_at, deleted_by, deleted_from_status`)
    .not("deleted_at", "is", null)
    .order("deleted_at", { ascending: false });
  if (opts.salesmanId) q = q.eq("salesman_id", opts.salesmanId);

  const { data, error } = await q;
  if (error) {
    if (error.code === "42703") trashColumnsMissing = true;
    return [];
  }
  const rows = (data as unknown as Order[]) ?? [];
  return (await attachRelations(supabase, rows)) as TrashedOrderRow[];
}

async function trashAction(path: string, orderId: string) {
  const res = await fetch(`/api/orders/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "That didn't work.");
  return data as {
    ok: true;
    invoiceNumber?: string | null;
    stockRestored?: number;
    stockTaken?: number;
    paymentsReleased?: number;
    status?: string;
  };
}

/** Move an order to the trash: stock back, payments released, out of every total. */
export const deleteOrder = (orderId: string) => trashAction("delete", orderId);
/** Put it back at the stage it was deleted from. */
export const restoreOrder = (orderId: string) => trashAction("restore", orderId);
/** Empty one order out of the trash for good. Manager only. */
export const purgeOrder = (orderId: string) => trashAction("purge", orderId);

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
  product: Pick<Product, "id" | "rack_location" | "price" | "stock_on_hand"> | null;
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
  const byId = new Map<string, Pick<Product, "id" | "rack_location" | "price" | "stock_on_hand">>();
  try {
    const { data: products, error: pErr } = await supabase
      .from("products")
      .select("id, rack_location, price, stock_on_hand")
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
  // Every figure on the Dashboard, Sales and Customers pages is built from a
  // briefly-held copy of the orders. Moving one has to drop it, or a screen
  // could show the old total for a few seconds after the change.
  invalidateOrderFacts();
  invalidateAging();
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

// ---- Telling people their order moved ----
//
// An order changing hands is the whole point of the pipeline, and until now
// only two events in the entire app produced a notification. A salesman had
// no way of learning their order was accepted, rejected, packed or approved
// short of opening it and looking. These put every handover in the right
// person's bell, which is what the previous version of this app did.
//
// Notification writes are deliberately best-effort: a bell that fails must
// never roll back a status change that already succeeded.

interface OrderRef {
  salesmanId: string | null;
  invoice: string;
  customerName: string | null;
}

async function orderRef(supabase: SupabaseClient, orderId: string): Promise<OrderRef> {
  // Two plain reads rather than a PostgREST embed: the rest of this file
  // joins by hand for the same reason (no confirmed FK constraint names),
  // and a failed embed here would silently cost someone their notification.
  const { data } = await supabase
    .from("orders")
    .select("salesman_id, invoice_number, new_customer_note, customer_id")
    .eq("id", orderId)
    .maybeSingle();

  let customerName = (data?.new_customer_note as string | null) ?? null;
  if (data?.customer_id) {
    const { data: c } = await supabase
      .from("customers")
      .select("name")
      .eq("id", data.customer_id)
      .maybeSingle();
    customerName = c?.name ?? customerName;
  }

  return {
    salesmanId: (data?.salesman_id as string | null) ?? null,
    // Before approval there is no invoice number, so say something a person
    // can still act on rather than "#null".
    invoice: data?.invoice_number ? `#${data.invoice_number}` : "the order",
    customerName,
  };
}

/** The order's own salesman, skipping the case where they did it themselves. */
async function notifySalesman(
  supabase: SupabaseClient,
  orderId: string,
  actorId: string,
  type: string,
  title: (ref: OrderRef) => string,
  body?: (ref: OrderRef) => string
) {
  try {
    const ref = await orderRef(supabase, orderId);
    if (!ref.salesmanId || ref.salesmanId === actorId) return;
    await notify(supabase, ref.salesmanId, type, title(ref), body?.(ref));
  } catch {
    // Best-effort by design — see above.
  }
}

async function notifyManagers(
  supabase: SupabaseClient,
  actorId: string,
  type: string,
  title: (ref: OrderRef) => string,
  orderId: string,
  body?: (ref: OrderRef) => string
) {
  try {
    const ref = await orderRef(supabase, orderId);
    const { data: managers } = await supabase
      .from("users")
      .select("id")
      .in("role", ["manager", "admin"])
      .eq("is_active", true);
    for (const m of managers ?? []) {
      if (m.id === actorId) continue;
      await notify(supabase, m.id, type, title(ref), body?.(ref));
    }
  } catch {
    // Best-effort by design — see above.
  }
}

export async function sendDraft(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "pending");
  await logStatus(supabase, orderId, actorId);
  await notifyManagers(
    supabase,
    actorId,
    "order_pending",
    () => "New order to review",
    orderId,
    (r) => (r.customerName ? `${r.customerName} — ${r.invoice}` : r.invoice)
  );
}

export async function acceptOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "waiting");
  await logStatus(supabase, orderId, actorId);
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_accepted",
    (r) => `Order accepted — ${r.invoice}`,
    () => "The manager accepted it. It is now with the warehouse."
  );
}

export async function rejectOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "rejected", { rejected_at: new Date().toISOString() });
  await logStatus(supabase, orderId, actorId);
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_rejected",
    (r) => `Order rejected — ${r.invoice}`,
    () => "Open it to see the manager's note. Resubmit within 30 days or it is deleted."
  );
}

export async function resubmitOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "pending", { rejected_at: null });
  await logStatus(supabase, orderId, actorId);
  await notifyManagers(
    supabase,
    actorId,
    "order_pending",
    (r) => `Order resubmitted — ${r.invoice}`,
    orderId,
    (r) => r.customerName ?? ""
  );
}

export async function startPicking(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "picking");
  await logStatus(supabase, orderId, actorId);
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_picking",
    (r) => `Picking started — ${r.invoice}`,
    () => "The warehouse has started picking this order."
  );
}

export async function markPacked(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "packed");
  await logStatus(supabase, orderId, actorId);
  // The manager is the one who has to act next: approving is what issues the
  // invoice and moves the stock.
  await notifyManagers(
    supabase,
    actorId,
    "order_packed",
    (r) => `Packed, waiting for approval — ${r.invoice}`,
    orderId,
    (r) => r.customerName ?? ""
  );
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_packed",
    (r) => `Order packed — ${r.invoice}`,
    () => "The warehouse has finished picking it."
  );
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
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_delivering",
    (r) => `Out for delivery — ${r.invoice}`,
    (r) => (r.customerName ? `On its way to ${r.customerName}.` : "")
  );
}

export async function confirmDelivery(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "delivered");
  await logStatus(supabase, orderId, actorId);
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_delivered",
    (r) => `Delivered — ${r.invoice}`,
    (r) => (r.customerName ? `${r.customerName} has received it.` : "")
  );
}

export async function cancelOrder(supabase: SupabaseClient, orderId: string, actorId: string) {
  await updateOrderStatus(supabase, orderId, "cancelled");
  await logStatus(supabase, orderId, actorId);
  await notifySalesman(
    supabase,
    orderId,
    actorId,
    "order_cancelled",
    (r) => `Order cancelled — ${r.invoice}`
  );
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

export interface ResumePoint {
  orderId: string;
  invoiceNumber: string | null;
  customerName: string | null;
  status: string;
  pickedAt: string;
}

/**
 * The order this person was last picking, if it is still open.
 *
 * Picking a large order is interrupted — a delivery arrives, a shift ends —
 * and finding your place again meant remembering the customer and hunting for
 * them in a list. This is that place.
 *
 * Read from the last line they actually picked rather than from the order's
 * own timestamps, because an order can be touched by more than one person and
 * "where I left off" is personal.
 */
export async function fetchResumePoint(
  supabase: SupabaseClient,
  userId: string
): Promise<ResumePoint | null> {
  const { data: lastPick, error } = await supabase
    .from("order_items")
    .select("order_id, picked_at")
    .eq("picked_by_id", userId)
    .not("picked_at", "is", null)
    .order("picked_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !lastPick) return null;

  const { data: order } = await supabase
    .from("orders")
    .select("id, invoice_number, status, customer:customers(name)")
    .eq("id", lastPick.order_id)
    .maybeSingle();
  if (!order) return null;

  // Only worth offering while there is still something to do on it.
  if (!["waiting", "picking", "accepted"].includes(order.status)) return null;

  const customer = order.customer as { name?: string } | { name?: string }[] | null;
  const customerName = Array.isArray(customer) ? customer[0]?.name ?? null : customer?.name ?? null;

  return {
    orderId: order.id,
    invoiceNumber: order.invoice_number ?? null,
    customerName,
    status: order.status,
    pickedAt: lastPick.picked_at as string,
  };
}
