import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recalcOrderTotals, stampEdited } from "@/lib/orders-server";
import { resolveLinePrice } from "@/lib/money";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Puts another line on an order that has already been written — the phone's
// WarehouseOrderPickView.addArticle(_:), which the web could not do at all:
// a forgotten article meant a second order or a deleted one.
//
// Who may, and when, is remove-item's rule and deliberately not a second
// one. Draft/pending: your own order unless you are a manager. Waiting /
// picking / packed: a manager or the warehouse (owner, 2026-09-21) — stock
// is only deducted at approval, so a line added at those stages is deducted
// with the rest. From approval on stock and an invoice are in play and the
// change goes through the edit-request flow instead.
const BEFORE_ACCEPTANCE = ["draft", "pending"];
const IN_THE_WAREHOUSE = ["waiting", "picking", "packed"];

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { orderId, productId, qty } = (await req.json()) as {
    orderId?: string;
    productId?: string;
    qty?: number;
  };
  if (!orderId || !productId) {
    return NextResponse.json({ error: t("orders.orderIdAndProductIdRequired") }, { status: 400 });
  }
  const quantity = qty === undefined ? 1 : Number(qty);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: t("orders.invalidQuantity") }, { status: 400 });
  }

  const supabase = supabaseCaller();
  const isManager = user.role === "manager" || user.role === "admin";

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, salesman_id, customer_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr || !order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });

  const afterAcceptance = IN_THE_WAREHOUSE.includes(order.status);
  if (afterAcceptance) {
    if (!isManager && user.role !== "warehouse") {
      return NextResponse.json({ error: t("common.warehouseOrManagerAccessRequired") }, { status: 403 });
    }
  } else if (!BEFORE_ACCEPTANCE.includes(order.status)) {
    return NextResponse.json(
      { error: t("orders.noLongerEditableDirectly") },
      { status: 409 }
    );
  } else if (!isManager && order.salesman_id !== user.id) {
    return NextResponse.json({ error: t("orders.onlyOwnOrders") }, { status: 403 });
  }

  // The cost snapshot is why this reads the product through the service-role
  // key, exactly as order creation does (see create/route.ts): a Salesman or
  // Warehouse session cannot read products.cost at all, and PostgREST refuses
  // the whole request over one forbidden column. Without it, GP and COGS for
  // this line would be permanently unrecoverable — every other line on the
  // order carries the snapshot, and a line added later must too.
  const admin = supabaseAdmin();
  const { data: product, error: productErr } = await admin
    .from("products")
    .select("id, sku, description, price, cost")
    .eq("id", productId)
    .maybeSingle();
  if (productErr) return NextResponse.json({ error: productErr.message }, { status: 400 });
  if (!product) return NextResponse.json({ error: t("orders.productNotFound") }, { status: 404 });

  // The customer's remembered price is the price, falling back to the list
  // price — the same resolution NewOrderSheet.addProduct does for a line
  // added at order time, so a line added afterwards is priced identically.
  // Resolved by the one shared rule (lib/money.ts resolveLinePrice): the old
  // price, else the list price. No automatic discount (2026-09-21).
  let stickyPrice: number | null = null;
  if (order.customer_id) {
    const { data: sticky } = await admin
      .from("customer_prices")
      .select("price")
      .eq("customer_id", order.customer_id)
      .eq("product_id", productId)
      .maybeSingle();
    stickyPrice = sticky?.price ?? null;
  }
  const unitPrice = resolveLinePrice({ listPrice: product.price, stickyPrice }).price;

  // Adding an article the order already has adds to that line rather than
  // opening a second one, which is what the phone does
  // (WarehouseOrderPickView.addArticle). Two lines for one article are not
  // wrong, but they read as a mistake on an invoice and the two apps should
  // not produce differently shaped orders from the same action. The price
  // already on the line is kept: it may have been negotiated, and adding
  // another box is not a reason to reprice what was agreed.
  const { data: existing } = await admin
    .from("order_items")
    .select("id, ordered_qty, picked_qty")
    .eq("order_id", orderId)
    .eq("product_id", productId)
    .limit(1)
    .maybeSingle();

  let itemId: string;
  if (existing) {
    // A picked line bills its picked quantity, so more boxes on a line that
    // is already ticked would not be billed at all. The tick comes off and
    // the line is picked again at its new quantity.
    const merged: Record<string, unknown> = { ordered_qty: (existing.ordered_qty ?? 0) + quantity };
    if (existing.picked_qty != null) {
      merged.picked_qty = null;
      merged.picked_by_id = null;
      merged.picked_at = null;
    }
    const { error: mergeErr } = await admin
      .from("order_items")
      .update(merged)
      .eq("id", existing.id);
    if (mergeErr) return NextResponse.json({ error: mergeErr.message }, { status: 400 });
    itemId = existing.id as string;
  } else {
    const { data: inserted, error: insertErr } = await admin
      .from("order_items")
      .insert({
        order_id: orderId,
        product_id: productId,
        sku: product.sku,
        description: product.description,
        unit_price: unitPrice,
        unit_cost: product.cost ?? null,
        ordered_qty: quantity,
      })
      .select("id")
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 400 });
    itemId = inserted.id as string;
  }

  // The warehouse holds no write privilege on orders' totals; role and stage
  // were checked above (same as remove-item).
  const writer = afterAcceptance ? admin : supabase;
  await recalcOrderTotals(writer, order.id, order.customer_id);
  const stamped = await stampEdited(writer, order.id, user.id);

  return NextResponse.json({ ok: true, itemId, merged: Boolean(existing), edited_stamped: stamped });
}
