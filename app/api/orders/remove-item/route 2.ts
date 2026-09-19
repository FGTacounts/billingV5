import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { recalcOrderTotals, stampEdited } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Takes a line back off an order. The other half of add-item, and under the
// same rule as update-item: draft/pending only, your own order unless you
// are a manager. Nothing has been deducted or billed at those stages, so the
// row simply goes; an order that has moved further is corrected through the
// pick/edit-request flow instead.
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

  if (!["draft", "pending"].includes(order.status)) {
    return NextResponse.json(
      { error: t("orders.noLongerEditableDirectly") },
      { status: 409 }
    );
  }
  if (!isManager && order.salesman_id !== user.id) {
    return NextResponse.json({ error: t("orders.onlyOwnOrders") }, { status: 403 });
  }

  const { error: deleteErr } = await supabase.from("order_items").delete().eq("id", itemId);
  if (deleteErr) return NextResponse.json({ error: deleteErr.message }, { status: 400 });

  await recalcOrderTotals(supabase, order.id, order.customer_id);
  const stamped = await stampEdited(supabase, order.id, user.id);

  return NextResponse.json({ ok: true, edited_stamped: stamped });
}
