import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Manager grants Warehouse's request to edit an already-approved order: the
// stock deduction from approval reverses and the order drops back to
// 'picking' (§6). Mirrors the deduction logic in approve/route.ts in reverse.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { orderId } = await req.json();
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.status !== "edit_requested") {
    return NextResponse.json({ error: "Order is not awaiting an edit decision" }, { status: 409 });
  }

  const { data: items, error: itemsErr } = await supabase
    .from("order_items")
    .select("product_id, ordered_qty, picked_qty")
    .eq("order_id", orderId);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  const qtyByProduct = new Map<string, number>();
  for (const it of items ?? []) {
    const qty = it.picked_qty ?? it.ordered_qty ?? 0;
    qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) ?? 0) + qty);
  }

  for (const [productId, qty] of qtyByProduct) {
    const { data: product } = await supabase
      .from("products")
      .select("stock_on_hand")
      .eq("id", productId)
      .maybeSingle();
    if (!product) continue;
    const { error: stockErr } = await supabase
      .from("products")
      .update({ stock_on_hand: (product.stock_on_hand ?? 0) + qty })
      .eq("id", productId);
    if (stockErr) return NextResponse.json({ error: stockErr.message }, { status: 500 });
  }

  // subtotal/vat_amount/total are NOT NULL (default 0, not nullable) —
  // reset to 0 rather than null; they're recomputed on the next approval.
  const { error: statusErr } = await supabase
    .from("orders")
    .update({ status: "picking", total: 0, subtotal: 0, vat_amount: 0 })
    .eq("id", orderId);
  if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });

  await supabase.from("order_status_log").insert({
    order_id: orderId,
    changed_by: user.id,
    changed_at: new Date().toISOString(),
  });

  return NextResponse.json({ ok: true });
}
