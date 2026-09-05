import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Empties one order out of the trash for good: the lines, the status history
// and the row itself. Manager-only, and only for something already in the
// trash — so an order can never be destroyed in one click from the list.
//
// The invoice number goes with it. A tax series should not have holes, which
// is why the trash exists at all: deleting keeps the number and the record,
// and this is the deliberate second step for something that should never
// have been an invoice.
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
    .select("id, deleted_at, invoice_number")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!order.deleted_at) {
    return NextResponse.json({ error: "Put it in the trash first." }, { status: 409 });
  }

  // Children first — the schema may or may not cascade, and a half-deleted
  // order is worse than none.
  await supabase.from("payment_orders").delete().eq("order_id", orderId);
  await supabase.from("order_items").delete().eq("order_id", orderId);
  await supabase.from("order_status_log").delete().eq("order_id", orderId);

  const { error: deleteErr } = await supabase.from("orders").delete().eq("id", orderId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, invoiceNumber: order.invoice_number });
}
