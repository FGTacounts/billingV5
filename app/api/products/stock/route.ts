import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Stock-on-hand only, available to Warehouse as well as Manager.
//
// The moment a shelf count disagrees with the system is while somebody is
// standing at the shelf picking. Making them find a manager afterwards is
// how the figure stays wrong. Scoped to this one field on its own route,
// the same way rack location is, so the warehouse never gets near price or
// cost on the same form.
export async function PATCH(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "warehouse" && user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Warehouse or Manager access required" }, { status: 403 });
  }

  const { productId, stockOnHand } = (await req.json()) as {
    productId?: string;
    stockOnHand?: number;
  };
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  const stock = Number(stockOnHand);
  if (!Number.isFinite(stock) || stock < 0) {
    return NextResponse.json({ error: "Enter a stock figure of zero or more." }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("products")
    .update({ stock_on_hand: Math.round(stock) })
    .eq("id", productId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
