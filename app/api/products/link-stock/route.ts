import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { comboRefusal } from "@/lib/combos-server";
import { supabaseCaller } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Shared stock: link two products so they sell from one stock figure, or
// take one back out. Any number of SKUs — combos too — can share one stock.
//
// Linking is one database function (scratchpad/RUN-ME-39 link_stock) that
// merges the two shelves: every SKU already sharing with either side joins
// too. Afterwards the RUN-ME-18 mirror keeps every SKU on the shelf at one
// figure. Taking one out keeps the figure it had at that moment.
//
// Manager-only, like every other product edit.

const MISSING_COLUMN = "stock_group_id";

function notReady(message: string): boolean {
  return message.includes(MISSING_COLUMN);
}

const NOT_READY_MESSAGE = t("products.sharedStockNotEnabled");

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { productId, partnerId } = (await req.json()) as { productId?: string; partnerId?: string };
  if (!productId || !partnerId) {
    return NextResponse.json({ error: t("products.productIdAndPartnerIdRequired") }, { status: 400 });
  }
  if (productId === partnerId) {
    return NextResponse.json({ error: t("products.cannotShareWithItself") }, { status: 400 });
  }

  // One database call does the whole link (RUN-ME-39 link_stock): every SKU
  // on either side ends up on ONE shelf — "multiple SKU and combo products
  // should be able to link to the same stock" (owner, 2026-11-08). Nothing is
  // taken off a shelf and nothing is asked. The figure is the highest counted
  // one, or on a combo shelf the lowest part's. Run as the caller, so the
  // function's own manager check applies, exactly as it does for the phone.
  const supabase = supabaseCaller();
  const { data, error } = await supabase.rpc("link_stock", { p_product: productId, p_partner: partnerId });
  if (error) {
    const missing = error.message.includes("link_stock") || error.code === "PGRST202";
    return NextResponse.json(
      { error: missing ? t("products.linkStockNeedsRunMe39") : comboRefusal(error.message) },
      { status: 400 }
    );
  }
  const outcome = data as { result: string; stock_group_id?: string; members?: unknown[] };
  if (outcome.result === "already") {
    // Already one shelf: answer with it as it stands.
    const { data: me } = await supabase.from("products").select("stock_group_id").eq("id", productId).maybeSingle();
    const groupId = (me?.stock_group_id as string | null) ?? null;
    const { data: group } = groupId
      ? await supabase.from("products").select("id, sku, stock_on_hand").eq("stock_group_id", groupId).order("sku")
      : { data: [] };
    return NextResponse.json({ ok: true, stockGroupId: groupId, members: group ?? [] });
  }
  return NextResponse.json({ ok: true, stockGroupId: outcome.stock_group_id, members: outcome.members ?? [] });
}

export async function DELETE(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { productId } = (await req.json()) as { productId?: string };
  if (!productId) return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });

  // Leaving keeps the figure it had at that moment; from here on the two
  // counts move on their own. A group left with one member is still a group
  // of one, which shows as nothing shared — harmless, and no second write.
  const admin = supabaseAdmin();
  const { error } = await admin.from("products").update({ stock_group_id: null }).eq("id", productId);
  if (error) {
    return NextResponse.json({ error: notReady(error.message) ? NOT_READY_MESSAGE : error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
