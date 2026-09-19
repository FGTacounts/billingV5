import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { stampEdited } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Pulls a packed order back into picking so the warehouse can rework it
// before handing it to the manager again — the phone's
// WarehouseOrderPickView.reopenForRepack().
//
// Nothing financial has happened yet at 'packed': no invoice number, no
// stock deduction (both of those are approval's business), so this is only a
// stage change. Whoever does the packing may undo it — warehouse, manager
// and admin — because the person who finds the wrong box is the packer.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });
  if (!["warehouse", "manager", "admin"].includes(user.role)) {
    return NextResponse.json({ error: t("orders.warehouseOrManagerAccessRequired") }, { status: 403 });
  }

  const { orderId } = (await req.json()) as { orderId?: string };
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr) return NextResponse.json({ error: orderErr.message }, { status: 400 });
  if (!order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });
  if (order.status !== "packed") {
    return NextResponse.json(
      { error: t("orders.onlyPackedCanBeReopened", { status: order.status }) },
      { status: 409 }
    );
  }

  const { error: statusErr } = await supabase
    .from("orders")
    .update({ status: "picking" })
    .eq("id", orderId);
  if (statusErr) return NextResponse.json({ error: statusErr.message }, { status: 500 });

  await supabase.from("order_status_log").insert({
    order_id: orderId,
    changed_by: user.id,
    changed_at: new Date().toISOString(),
  });

  // Stamped, because the phone stamps it (WarehouseOrderPickView
  // .reopenForRepack) and because pulling a packed order back apart is
  // exactly the kind of thing the next person to look at it should see.
  const stamped = await stampEdited(supabase, orderId, user.id);

  return NextResponse.json({ ok: true, status: "picking", edited_stamped: stamped });
}
