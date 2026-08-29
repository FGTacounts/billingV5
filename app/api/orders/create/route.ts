import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Order creation is routed through the service-role key so unit_cost can be
// snapshotted onto order_items at order time (§6 data model) even though
// the creating session (often Salesman/Warehouse) can only ever read
// products_safe, which nulls cost by RLS. Without this, GP/COGS would be
// permanently unrecoverable for every order — cost is masked for display,
// not simply absent, so it still has to be captured here.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { customer_id, new_customer_note, status, hold_reason, warehouse_note, salesman_note, manager_note, lines } = body as {
    customer_id: string | null;
    new_customer_note: string | null;
    status: "draft" | "pending";
    hold_reason?: string | null;
    warehouse_note?: string | null;
    salesman_note?: string | null;
    manager_note?: string | null;
    lines: { product_id: string; sku: string; description: string | null; unit_price: number; ordered_qty: number }[];
  };

  if (!Array.isArray(lines) || lines.length === 0) {
    return NextResponse.json({ error: "At least one line item is required" }, { status: 400 });
  }
  if (!customer_id && !new_customer_note) {
    return NextResponse.json({ error: "customer_id or new_customer_note is required" }, { status: 400 });
  }

  const admin = supabaseAdmin();

  const { data: order, error: orderErr } = await admin
    .from("orders")
    .insert({
      customer_id: customer_id ?? null,
      new_customer_note: new_customer_note ?? null,
      warehouse_note: warehouse_note?.trim() || null,
      salesman_note: salesman_note?.trim() || null,
      manager_note: manager_note?.trim() || null,
      salesman_id: caller.id,
      status,
    })
    .select("id")
    .single();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });

  // Invoice numbers are deliberately NOT assigned here. They are issued at
  // approval, so that a cancelled or rejected order never consumes one and
  // the invoice series has no gaps — a gapless series is the requirement,
  // and it is incompatible with numbering at creation.

  const productIds = [...new Set(lines.map((l) => l.product_id))];
  const { data: products, error: productsErr } = await admin
    .from("products")
    .select("id, cost")
    .in("id", productIds);
  if (productsErr) return NextResponse.json({ error: productsErr.message }, { status: 400 });
  const costById = new Map((products ?? []).map((p) => [p.id, p.cost]));

  const { error: itemsErr } = await admin.from("order_items").insert(
    lines.map((l) => ({
      order_id: order.id,
      product_id: l.product_id,
      sku: l.sku,
      description: l.description,
      unit_price: l.unit_price,
      unit_cost: costById.get(l.product_id) ?? null,
      ordered_qty: l.ordered_qty,
    }))
  );
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 400 });

  if (hold_reason) {
    await admin.from("payment_delay_notes").insert({
      order_id: order.id,
      note: hold_reason,
      added_by: caller.id,
    });
  }

  return NextResponse.json({ orderId: order.id as string });
}
