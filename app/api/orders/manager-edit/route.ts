import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { managerEditOrder } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// The two manager changes that have no older route: the order the lines are
// listed in, and the discount on the whole order (owner, 2026-09-25). Both go
// through manager_edit_order, which checks the caller is a manager or admin
// and recomputes the totals with the discount. They need RUN-ME-28; there is
// no fallback, because before it there is nowhere to keep either.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { orderId, lineOrder, discount } = (await req.json()) as {
    orderId?: string;
    lineOrder?: string[];
    discount?: number;
  };
  if (!orderId || (lineOrder === undefined && discount === undefined)) {
    return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });
  }
  if (lineOrder !== undefined && (!Array.isArray(lineOrder) || lineOrder.some((id) => typeof id !== "string"))) {
    return NextResponse.json({ error: t("orders.itemIdRequired") }, { status: 400 });
  }
  if (discount !== undefined && (!Number.isFinite(Number(discount)) || Number(discount) < 0)) {
    return NextResponse.json({ error: t("orders.invalidDiscount") }, { status: 400 });
  }

  const result = await managerEditOrder(
    supabaseCaller(),
    orderId,
    lineOrder ? [{ op: "arrange", ids: lineOrder }] : [],
    discount === undefined ? undefined : Number(discount)
  );
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.missing) return NextResponse.json({ error: t("orders.needsDatabaseUpdate") }, { status: 409 });
  return NextResponse.json({ error: result.message }, { status: 400 });
}
