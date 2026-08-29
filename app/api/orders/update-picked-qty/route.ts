import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Routed through the service-role key so Warehouse (and Manager) sessions
// never need direct table privileges on order_items — that table carries
// unit_cost, which RLS can restrict per-row but never per-column (§6: "RLS
// is row-level only — column masking needs the view pattern"). Once the
// raw order_items/products tables are locked to Manager-only SELECT (see
// the RLS fix), this is the only way picking still works for Warehouse.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "warehouse" && (caller.role !== "manager" && caller.role !== "admin"))) {
    return NextResponse.json({ error: "Warehouse or Manager access required" }, { status: 403 });
  }

  const { itemId, pickedQty } = await req.json();
  if (!itemId || typeof pickedQty !== "number") {
    return NextResponse.json({ error: "itemId and pickedQty are required" }, { status: 400 });
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
