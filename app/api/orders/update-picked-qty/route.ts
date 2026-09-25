import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseCaller } from "@/lib/supabase/server";
import { managerEditOrder } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Routed through the service-role key so Warehouse (and Manager) sessions
// never need direct table privileges on order_items — that table carries
// unit_cost, which RLS can restrict per-row but never per-column (§6: "RLS
// is row-level only — column masking needs the view pattern"). Once the
// raw order_items/products tables are locked to Manager-only SELECT (see
// the RLS fix), this is the only way picking still works for Warehouse.
//
// A manager or admin may pick or unpick (pickedQty null) at any stage
// (owner, 2026-09-25). That goes through manager_edit_order: once an order is
// approved the picked figure is what is billed, so a pick changes the stock
// and the totals, and they have to move together.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "warehouse" && (caller.role !== "manager" && caller.role !== "admin"))) {
    return NextResponse.json({ error: t("common.warehouseOrManagerAccessRequired") }, { status: 403 });
  }

  const { itemId, pickedQty } = await req.json();
  const isManager = caller.role === "manager" || caller.role === "admin";
  const unpick = pickedQty === null && isManager;
  if (!itemId || (!unpick && (typeof pickedQty !== "number" || pickedQty < 0))) {
    return NextResponse.json({ error: t("orders.itemIdAndPickedQtyRequired") }, { status: 400 });
  }

  if (isManager) {
    const supabase = supabaseCaller();
    const { data: item } = await supabase.from("order_items").select("order_id").eq("id", itemId).maybeSingle();
    if (!item) return NextResponse.json({ error: t("orders.orderItemNotFound") }, { status: 404 });
    const result = await managerEditOrder(supabase, item.order_id, [{ op: "pick", id: itemId, qty: unpick ? null : pickedQty }]);
    if (result.ok) return NextResponse.json({ ok: true });
    if (!result.missing) return NextResponse.json({ error: result.message }, { status: 400 });
    // No RUN-ME-28 yet: a plain pick, as before; unpicking needs it.
    if (unpick) return NextResponse.json({ error: t("orders.needsDatabaseUpdate") }, { status: 409 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("order_items")
    .update({
      picked_qty: pickedQty,
      picked_by_id: caller.id,
      picked_at: new Date().toISOString(),
    })
    .eq("id", itemId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
