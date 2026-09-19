import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Takes an approved order back to 'packed' — the phone's
// AppDataManager.unapproveOrder, which the web had no answer to at all: an
// order approved by mistake could only be deleted, which threw its history
// away and released its payments.
//
// It is the approval run backwards: the stock that was deducted goes back on
// the shelf and the billed figures are cleared (subtotal/vat_amount/total are
// NOT NULL columns, so 0 rather than null, exactly as grant-edit does) to be
// recomputed by the next approval.
//
// The invoice number is NOT taken away. Approving again finds a number
// already on the order and keeps it (see the idempotent block in
// approve/route.ts), so an order cannot burn a second number by being
// unapproved and approved again, and the series stays gapless.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { orderId } = (await req.json()) as { orderId?: string };
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, invoice_number, salesman_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });
  if (!order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });
  if (order.status !== "approved") {
    return NextResponse.json(
      { error: t("orders.onlyApprovedCanBeTakenBack", { status: order.status }) },
      { status: 409 }
    );
  }

  const { data: items, error: itemsErr } = await supabase
    .from("order_items")
    .select("product_id, ordered_qty, picked_qty")
    .eq("order_id", orderId);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // What was actually fulfilled is what was deducted — the picked quantity
  // where there is one, the ordered quantity where picking was skipped.
  const qtyByProduct = new Map<string, number>();
  for (const it of items ?? []) {
    const qty = it.picked_qty ?? it.ordered_qty ?? 0;
    if (!it.product_id || qty <= 0) continue;
    qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) ?? 0) + qty);
  }

  // Read-then-write per product, the same shape as grant-edit. Each product
  // is re-read inside the loop, so two SKUs sharing one shelf (RUN-ME-18)
  // accumulate correctly rather than the second write overwriting the first.
  let stockRestored = 0;
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
    stockRestored += qty;
  }

  const { error: statusErr } = await supabase
    .from("orders")
    .update({ status: "packed", subtotal: 0, vat_amount: 0, total: 0 })
    .eq("id", orderId);
  if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });

  await supabase.from("order_status_log").insert({
    order_id: orderId,
    changed_by: user.id,
    changed_at: new Date().toISOString(),
  });

  // The salesman was told the moment it was approved, so they are told when
  // it is taken back. Best-effort, like every other bell in the pipeline: a
  // failed notification must not undo a status change that has already put
  // the stock back.
  if (order.salesman_id && order.salesman_id !== user.id) {
    await supabase
      .from("notifications")
      .insert({
        user_id: order.salesman_id,
        type: "order_unapproved",
        title: order.invoice_number
          ? t("orders.approvalUndoneInvoice", { invoiceNumber: order.invoice_number })
          : t("orders.approvalUndone"),
        body: t("orders.takenBackToPackingBy", { name: user.full_name }),
        is_read: false,
      })
      .then(undefined, () => {});
  }

  return NextResponse.json({
    ok: true,
    status: "packed",
    invoiceNumber: order.invoice_number ?? null,
    stockRestored,
  });
}
