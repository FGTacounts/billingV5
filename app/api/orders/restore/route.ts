import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Puts an order back at the stage it was deleted from, and takes the stock
// off the shelf again if that stage is one where it had been deducted.
//
// Payments are deliberately not re-applied: deleting released them back to
// the customer, and they may have been put against another invoice since.
// The caller is told so it can say it.
const STOCK_DEDUCTED = ["approved", "delivering", "delivered"];

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { orderId } = (await req.json()) as { orderId?: string };
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, deleted_at, deleted_from_status, invoice_number")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!order.deleted_at) return NextResponse.json({ error: "That order is not in the trash." }, { status: 409 });

  const back = (order.deleted_from_status as string | null) ?? "pending";

  let stockTaken = 0;
  if (STOCK_DEDUCTED.includes(back)) {
    const { data: items } = await supabase
      .from("order_items")
      .select("product_id, ordered_qty, picked_qty")
      .eq("order_id", orderId);
    const qtyByProduct = new Map<string, number>();
    for (const it of items ?? []) {
      const qty = it.picked_qty ?? it.ordered_qty ?? 0;
      if (!it.product_id || qty <= 0) continue;
      qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) ?? 0) + qty);
    }
    for (const [productId, qty] of qtyByProduct) {
      const { data: product } = await supabase
        .from("products")
        .select("stock_on_hand")
        .eq("id", productId)
        .maybeSingle();
      if (!product) continue;
      // Never below zero — the same floor the rest of the app keeps.
      await supabase
        .from("products")
        .update({ stock_on_hand: Math.max(0, (product.stock_on_hand ?? 0) - qty) })
        .eq("id", productId);
      stockTaken += qty;
    }
  }

  const { error: updateErr } = await supabase
    .from("orders")
    .update({ status: back, deleted_at: null, deleted_by: null, deleted_from_status: null })
    .eq("id", orderId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    status: back,
    invoiceNumber: order.invoice_number,
    stockTaken,
  });
}
