import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { resolveLinePrice } from "@/lib/money";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Order creation is routed through the service-role key so unit_cost can be
// snapshotted onto order_items at order time (§6 data model) even though
// the creating session (often Salesman/Warehouse) can only ever read
// products_safe, which nulls cost by RLS. Without this, GP/COGS would be
// permanently unrecoverable for every order — cost is masked for display,
// not simply absent, so it still has to be captured here.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

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
    return NextResponse.json({ error: t("orders.atLeastOneLineItem") }, { status: 400 });
  }
  if (!customer_id && !new_customer_note) {
    return NextResponse.json({ error: t("orders.customerRequired") }, { status: 400 });
  }
  // The TypeScript annotation above says draft | pending, but nothing enforced
  // it at run time, and this insert runs as service_role. A caller posting
  // status: "delivered" got an order that had skipped picking, packing and
  // delivery, never took an invoice number, and never moved any stock — a
  // sale that exists in the totals but nowhere in the pipeline. An order can
  // only ever be born as a draft or as pending; everything after that is the
  // status machine's business.
  if (status !== "draft" && status !== "pending") {
    return NextResponse.json({ error: t("orders.createStatusInvalid") }, { status: 400 });
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
    .select("id, cost, price")
    .in("id", productIds);
  if (productsErr) return NextResponse.json({ error: productsErr.message }, { status: 400 });
  const costById = new Map((products ?? []).map((p) => [p.id, p.cost]));

  // Only a manager sets a price (owner, 2026-09-21). For anyone else the
  // price the browser sent is not read at all: the line charges what this
  // customer was last billed for the product, else the list price — worked
  // out here, from figures read here. A lower price used to arrive from the
  // form and print on the invoice as a discount nobody had given.
  const callerSetsPrices = caller.role === "manager" || caller.role === "admin";
  const priceFor = new Map<string, number>();
  if (!callerSetsPrices) {
    const oldPrices = new Map<string, number>();
    if (customer_id) {
      const { data: remembered } = await admin
        .from("customer_prices")
        .select("product_id, price")
        .eq("customer_id", customer_id)
        .in("product_id", productIds);
      for (const row of remembered ?? []) oldPrices.set(row.product_id, row.price);
    }
    for (const p of products ?? []) {
      priceFor.set(
        p.id,
        resolveLinePrice({ listPrice: Number(p.price) || 0, stickyPrice: oldPrices.get(p.id) ?? null }).price
      );
    }
  }

  const { error: itemsErr } = await admin.from("order_items").insert(
    lines.map((l) => ({
      order_id: order.id,
      product_id: l.product_id,
      sku: l.sku,
      description: l.description,
      unit_price: callerSetsPrices ? l.unit_price : priceFor.get(l.product_id) ?? l.unit_price,
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

  // An order sent for review lands in every manager's bell. A draft doesn't —
  // nobody else needs to know about a note-to-self.
  if (status === "pending") {
    const { data: managers } = await admin
      .from("users")
      .select("id")
      .in("role", ["manager", "admin"])
      .eq("is_active", true);
    const recipients = (managers ?? []).filter((m) => m.id !== caller.id);
    if (recipients.length) {
      let customerName: string | null = new_customer_note ?? null;
      if (customer_id) {
        const { data: c } = await admin.from("customers").select("name").eq("id", customer_id).maybeSingle();
        customerName = c?.name ?? customerName;
      }
      await admin.from("notifications").insert(
        recipients.map((m) => ({
          user_id: m.id,
          type: "order_pending",
          title: t("orders.newOrderFrom", { name: caller.full_name }),
          body: [
            customerName,
            lines.length === 1
              ? t("orders.itemCountOne", { n: lines.length })
              : t("orders.itemCountMany", { n: lines.length }),
          ]
            .filter(Boolean)
            .join(" — "),
          is_read: false,
        }))
      );
    }
  }

  return NextResponse.json({ orderId: order.id as string });
}
