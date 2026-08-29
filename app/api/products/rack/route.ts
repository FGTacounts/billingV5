import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Rack-location-only edit, available to Warehouse as well as Manager
// (Order Flow & Additions §8.2 — extends what was Manager-only). Scoped to
// just this one field via a dedicated route rather than the full product
// editor, since Warehouse shouldn't see/touch price/cost on the same form.
export async function PATCH(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "warehouse" && (user.role !== "manager" && user.role !== "admin"))) {
    return NextResponse.json({ error: "Warehouse or Manager access required" }, { status: 403 });
  }

  const { productId, rackLocation } = (await req.json()) as { productId?: string; rackLocation?: string };
  if (!productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("products")
    .update({ rack_location: rackLocation?.trim() || null })
    .eq("id", productId);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true });
}
