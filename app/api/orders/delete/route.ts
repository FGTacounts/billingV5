import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Deleting an order is not throwing the row away. It moves to the Trash in
// Orders, keeps its invoice number and its history, and stops counting
// anywhere — sales, statements, receivables — because it goes to
// `cancelled`, which no report counts.
//
// Two things have to be undone with it, or the books stay wrong:
//   • stock deducted at approval goes back on the shelf;
//   • any payment applied to it is released, so the money returns to the
//     customer's unapplied balance instead of vanishing with the invoice.
//
// A Manager may delete any order. A Salesman may delete their own, but only
// while it is still a draft or pending — after that it has been through
// somebody else's hands.
const STOCK_DEDUCTED = ["approved", "delivering", "delivered"];

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 403 });

  const { orderId } = (await req.json()) as { orderId?: string };
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, salesman_id, invoice_number, deleted_at")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) {
    // The columns arrive with RUN-ME-12; say so rather than failing oddly.
    if (orderErr.code === "42703") {
      return NextResponse.json(
        { error: "Deleting orders needs the RUN-ME-12 file run in Supabase first." },
        { status: 501 }
      );
    }
    return NextResponse.json({ error: orderErr.message }, { status: 400 });
  }
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (order.deleted_at) return NextResponse.json({ error: "That order is already in the trash." }, { status: 409 });

  const isManager = user.role === "manager" || user.role === "admin";
  const ownDraft = order.salesman_id === user.id && ["draft", "pending"].includes(order.status);
  if (!isManager && !ownDraft) {
    return NextResponse.json(
      { error: "Only a manager can delete an order once it has left you." },
      { status: 403 }
    );
  }

  // 1. Stock back on the shelf, if approval ever took it off.
  let stockRestored = 0;
  if (STOCK_DEDUCTED.includes(order.status)) {
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
      await supabase
        .from("products")
        .update({ stock_on_hand: (product.stock_on_hand ?? 0) + qty })
        .eq("id", productId);
      stockRestored += qty;
    }
  }

  // 2. Release any payment applied to it. The payment itself stays — only
  //    its claim on this invoice goes, so the customer keeps the credit.
  const { data: released } = await supabase
    .from("payment_orders")
    .delete()
    .eq("order_id", orderId)
    .select("payment_id");
  const paymentsReleased = released?.length ?? 0;

  const { error: updateErr } = await supabase
    .from("orders")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: user.id,
      deleted_from_status: order.status,
      status: "cancelled",
    })
    .eq("id", orderId);
  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 400 });

  return NextResponse.json({
    ok: true,
    invoiceNumber: order.invoice_number,
    stockRestored,
    paymentsReleased,
  });
}
