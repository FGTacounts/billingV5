import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { subtotal as calcSubtotal, vat as calcVat, total as calcTotal, FALLBACK_VAT_RATE } from "@/lib/money";
import { resolveVatRate } from "@/lib/queries/zones";

export const runtime = "nodejs";

// Edits a line item's quantity/price on a not-yet-accepted order (§Next
// Updates Orders: "make order data editable"). Scoped to draft/pending —
// once an order is accepted, quantity changes go through the existing
// pick/edit-request flow instead (stock and invoices are already in play by
// then, so a silent qty/price edit there would be unsafe).
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { itemId, orderedQty, unitPrice } = await req.json();
  if (!itemId || (orderedQty === undefined && unitPrice === undefined)) {
    return NextResponse.json({ error: "itemId and at least one of orderedQty/unitPrice are required" }, { status: 400 });
  }

  const supabase = supabaseServer();
  const isManager = user.role === "manager" || user.role === "admin";

  const { data: item, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !item) return NextResponse.json({ error: "Order item not found" }, { status: 404 });

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, salesman_id, customer_id")
    .eq("id", item.order_id)
    .maybeSingle();
  if (orderErr || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  if (!["draft", "pending"].includes(order.status)) {
    return NextResponse.json({ error: "This order can no longer be edited directly — use the edit-request flow instead." }, { status: 409 });
  }
  if (!isManager && order.salesman_id !== user.id) {
    return NextResponse.json({ error: "You can only edit your own orders" }, { status: 403 });
  }

  const patch: Record<string, unknown> = {};
  if (orderedQty !== undefined) {
    const q = Number(orderedQty);
    if (!Number.isFinite(q) || q < 0) return NextResponse.json({ error: "Invalid quantity" }, { status: 400 });
    patch.ordered_qty = q;
  }
  if (unitPrice !== undefined) {
    const p = Number(unitPrice);
    if (!Number.isFinite(p) || p < 0) return NextResponse.json({ error: "Invalid price" }, { status: 400 });
    patch.unit_price = p;
  }

  const { error: updateErr } = await supabase.from("order_items").update(patch).eq("id", itemId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });

  const { data: allItems } = await supabase
    .from("order_items")
    .select("unit_price, ordered_qty, picked_qty")
    .eq("order_id", order.id);

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const fallbackRate = settings?.vat_rate ?? FALLBACK_VAT_RATE;
  let customerCountry: string | null = null;
  if (order.customer_id) {
    const { data: cust } = await supabase.from("customers").select("country_code").eq("id", order.customer_id).maybeSingle();
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
    .eq("id", order.id);

  return NextResponse.json({ ok: true });
}
