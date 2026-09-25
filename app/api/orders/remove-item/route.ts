import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { recalcOrderTotals, stampEdited, managerEditOrder } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Takes a line back off an order. The other half of add-item, and under the
// same rule as update-item while the order is a draft or pending: your own
// order unless you are a manager.
//
// Once accepted (waiting / picking / packed) the order is in the warehouse's
// hands, and a line that turns out not to be on the shelf has to be able to
// come off it: a manager or the warehouse may remove one (owner, 2026-09-21).
// Stock is only deducted at approval, so at every one of these stages the row
// simply goes. From approval on, stock has moved and an invoice exists, and
// the order is corrected through the edit-request flow instead — except by
// a manager or admin, who may take a line off at any stage (owner,
// 2026-09-25): manager_edit_order puts its stock back if approval had taken
// it, and recomputes the totals, in one transaction.
const BEFORE_ACCEPTANCE = ["draft", "pending"];
const IN_THE_WAREHOUSE = ["waiting", "picking", "packed"];

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const { itemId } = (await req.json()) as { itemId?: string };
  if (!itemId) return NextResponse.json({ error: t("orders.itemIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();
  const isManager = user.role === "manager" || user.role === "admin";

  const { data: item, error: itemErr } = await supabase
    .from("order_items")
    .select("id, order_id")
    .eq("id", itemId)
    .maybeSingle();
  if (itemErr || !item) return NextResponse.json({ error: t("orders.orderItemNotFound") }, { status: 404 });

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, salesman_id, customer_id")
    .eq("id", item.order_id)
    .maybeSingle();
  if (orderErr || !order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });

  if (isManager) {
    const result = await managerEditOrder(supabase, order.id, [{ op: "remove", id: itemId }]);
    if (result.ok) return NextResponse.json({ ok: true, edited_stamped: true });
    if (!result.missing) return NextResponse.json({ error: result.message }, { status: 400 });
  }

  const afterAcceptance = IN_THE_WAREHOUSE.includes(order.status);
  if (afterAcceptance) {
    if (!isManager && user.role !== "warehouse") {
      return NextResponse.json({ error: t("common.warehouseOrManagerAccessRequired") }, { status: 403 });
    }
  } else if (!BEFORE_ACCEPTANCE.includes(order.status)) {
    return NextResponse.json(
      { error: t("orders.noLongerEditableDirectly") },
      { status: 409 }
    );
  } else if (!isManager && order.salesman_id !== user.id) {
    return NextResponse.json({ error: t("orders.onlyOwnOrders") }, { status: 403 });
  }

  // The warehouse has no table privileges on order_items beyond reading —
  // its picks go through the admin key for the same reason (see
  // update-picked-qty). The role and the stage were checked above.
  const writer = afterAcceptance ? supabaseAdmin() : supabase;

  const { error: deleteErr } = await writer.from("order_items").delete().eq("id", itemId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 400 });

  await recalcOrderTotals(writer, order.id, order.customer_id);
  const stamped = await stampEdited(writer, order.id, user.id);

  return NextResponse.json({ ok: true, edited_stamped: stamped });
}
