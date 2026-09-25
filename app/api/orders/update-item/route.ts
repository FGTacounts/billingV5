import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { recalcOrderTotals, stampEdited } from "@/lib/orders-server";
import { lineDiscountPrice } from "@/lib/money";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Edits a line item's quantity/price on a not-yet-accepted order (§Next
// Updates Orders: "make order data editable"). Scoped to draft/pending —
// once an order is accepted, quantity changes go through the existing
// pick/edit-request flow instead (stock and invoices are already in play by
// then, so a silent qty/price edit there would be unsafe).
//
// `discountPercent` is the manager's per-product discount (owner, 2026-09-18).
// There is no discount column on order_items, deliberately (2026-09-04): what
// a line charges is its unit_price, and the invoice's Discount column is the
// gap between the product's list price and that. So a discount is stored as
// the price it produces — list price less N% — worked out here, from the list
// price the server reads itself, and only for a manager or admin.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { itemId, orderedQty, unitPrice, discountPercent } = await req.json();
  if (!itemId || (orderedQty === undefined && unitPrice === undefined && discountPercent === undefined)) {
    return NextResponse.json({ error: t("orders.itemIdAndFieldRequired") }, { status: 400 });
  }

  const supabase = supabaseCaller();
  const isManager = user.role === "manager" || user.role === "admin";

  const { data: item, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id, product_id")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !item) return NextResponse.json({ error: t("orders.orderItemNotFound") }, { status: 404 });

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, salesman_id, customer_id")
    .eq("id", item.order_id)
    .maybeSingle();
  if (orderErr || !order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });

  if (!["draft", "pending"].includes(order.status)) {
    return NextResponse.json({ error: t("orders.noLongerEditableDirectly") }, { status: 409 });
  }
  if (!isManager && order.salesman_id !== user.id) {
    return NextResponse.json({ error: t("orders.onlyOwnOrders") }, { status: 403 });
  }

  const patch: Record<string, unknown> = {};
  if (orderedQty !== undefined) {
    const q = Number(orderedQty);
    if (!Number.isFinite(q) || q < 0) return NextResponse.json({ error: t("orders.invalidQuantity") }, { status: 400 });
    patch.ordered_qty = q;
  }
  if (unitPrice !== undefined) {
    // A price is the manager's to change (owner, 2026-09-21). A salesman's
    // line charges the old price or the list price, and a lower one used to
    // print as a discount nobody had given.
    if (!isManager) return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
    const p = Number(unitPrice);
    if (!Number.isFinite(p) || p < 0) return NextResponse.json({ error: t("orders.invalidPrice") }, { status: 400 });
    patch.unit_price = p;
  }

  if (discountPercent !== undefined) {
    if (!isManager) return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
    const pct = Number(discountPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return NextResponse.json({ error: t("orders.invalidDiscount") }, { status: 400 });
    }
    const { data: product } = item.product_id
      ? await supabase.from("products").select("price").eq("id", item.product_id).maybeSingle()
      : { data: null };
    const listPrice = Number(product?.price) || 0;
    if (listPrice <= 0) return NextResponse.json({ error: t("orders.noListPriceForDiscount") }, { status: 400 });
    patch.unit_price = lineDiscountPrice(listPrice, pct);
  }

  const { error: updateErr } = await supabase.from("order_items").update(patch).eq("id", itemId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });

  // The same recompute add-item and remove-item do — one copy of it, in
  // lib/orders-server.ts, so the three routes cannot drift apart.
  await recalcOrderTotals(supabase, order.id, order.customer_id);

  // Somebody changed what is on this order, so it carries the Edited stamp
  // (RUN-ME-19). Best-effort: an un-migrated database still saves the edit.
  const stamped = await stampEdited(supabase, order.id, user.id);

  return NextResponse.json({ ok: true, edited_stamped: stamped });
}
