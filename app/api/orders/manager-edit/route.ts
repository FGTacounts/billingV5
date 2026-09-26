import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { managerEditOrder, type ManagerChange } from "@/lib/orders-server";
import { toFils, toAed } from "@/lib/money";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// The two manager changes that have no older route: the order the lines are
// listed in, and the discount on the whole order (owner, 2026-09-25). Both go
// through manager_edit_order, which checks the caller is a manager or admin
// and recomputes the totals with the discount. They need RUN-ME-28; there is
// no fallback, because before it there is nowhere to keep either.
//
// A third: a percentage off every line at once (owner, 2026-09-26: "full
// order discount, applies generally to all products"). Each line's price is
// cut by the percentage from what it charges now — on top of any price a
// manager has set — and all of them are written in one manager_edit_order
// call, so the order is never left half-discounted. It is an action, not a
// setting: nothing records the percentage, and applying 10% twice takes 10%
// off twice. The Disc % on each line reads it back.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { orderId, lineOrder, discount, linePercent } = (await req.json()) as {
    orderId?: string;
    lineOrder?: string[];
    discount?: number;
    linePercent?: number;
  };
  if (!orderId || (lineOrder === undefined && discount === undefined && linePercent === undefined)) {
    return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });
  }
  if (lineOrder !== undefined && (!Array.isArray(lineOrder) || lineOrder.some((id) => typeof id !== "string"))) {
    return NextResponse.json({ error: t("orders.itemIdRequired") }, { status: 400 });
  }
  if (discount !== undefined && (!Number.isFinite(Number(discount)) || Number(discount) < 0)) {
    return NextResponse.json({ error: t("orders.invalidDiscount") }, { status: 400 });
  }

  const pct = linePercent === undefined ? undefined : Number(linePercent);
  if (pct !== undefined && (!Number.isFinite(pct) || pct <= 0 || pct > 100)) {
    return NextResponse.json({ error: t("orders.invalidDiscount") }, { status: 400 });
  }

  const supabase = supabaseCaller();
  const changes: ManagerChange[] = lineOrder ? [{ op: "arrange", ids: lineOrder }] : [];
  if (pct !== undefined) {
    const { data: lines, error } = await supabase.from("order_items").select("id, unit_price").eq("order_id", orderId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    for (const line of lines ?? []) {
      // In whole fils, so the new price is exact to the fil.
      const fils = Math.round((toFils(Number(line.unit_price) || 0) * (100 - pct)) / 100);
      changes.push({ op: "set", id: line.id, unit_price: toAed(fils) });
    }
  }

  const result = await managerEditOrder(
    supabase,
    orderId,
    changes,
    discount === undefined ? undefined : Number(discount)
  );
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.missing) return NextResponse.json({ error: t("orders.needsDatabaseUpdate") }, { status: 409 });
  return NextResponse.json({ error: result.message }, { status: 400 });
}
