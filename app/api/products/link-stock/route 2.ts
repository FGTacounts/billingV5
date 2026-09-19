import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Shared stock: put one product under another product's stock, or take it
// back out. Two SKUs that are the same physical shelf keep one figure.
//
// The database does the real work (scratchpad/RUN-ME-18-shared-stock.sql):
// joining a group adopts the group's stock_on_hand, and any later change to
// one member is copied to the rest. This route only decides which group id
// the two rows carry, so the rule "the product being linked joins the
// partner's stock" lives in one place.
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

  const { productId, partnerId, confirmMove } = (await req.json()) as {
    productId?: string;
    partnerId?: string;
    // Set only after the person has been told what the move costs and said
    // yes. Without it a product that already shares a shelf is not moved.
    confirmMove?: boolean;
  };
  if (!productId || !partnerId) {
    return NextResponse.json({ error: t("products.productIdAndPartnerIdRequired") }, { status: 400 });
  }
  if (productId === partnerId) {
    return NextResponse.json({ error: t("products.cannotShareWithItself") }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: rows, error: readErr } = await admin
    .from("products")
    .select("id, sku, stock_group_id")
    .in("id", [productId, partnerId]);
  if (readErr) {
    return NextResponse.json(
      { error: notReady(readErr.message) ? NOT_READY_MESSAGE : readErr.message },
      { status: 400 }
    );
  }
  const partner = rows?.find((r) => r.id === partnerId);
  const product = rows?.find((r) => r.id === productId);
  if (!partner || !product) return NextResponse.json({ error: t("products.notFound") }, { status: 404 });

  // Moving a product off a shelf it already shares is never silent.
  //
  // A shelf holds any number of SKUs — that is the whole point, one physical
  // stock sold as several models, sizes or colours. But a SKU belongs to ONE
  // shelf, so adding one that is already on another takes it off that one,
  // and whoever it was sharing with is left behind holding the figure it had
  // at that moment. Nobody would guess that from "add a product", so it is
  // named and asked about rather than done.
  if (product.stock_group_id && product.stock_group_id !== partner.stock_group_id) {
    const { data: current } = await admin
      .from("products")
      .select("sku")
      .eq("stock_group_id", product.stock_group_id)
      .neq("id", productId)
      .order("sku");
    const movingFrom = (current ?? []).map((r) => r.sku as string);
    // A group of one is not a shelf anybody shares; moving out of it costs
    // nothing and needs no confirmation.
    if (movingFrom.length > 0 && !confirmMove) {
      return NextResponse.json(
        { needsConfirmation: true, sku: product.sku, movingFrom },
        { status: 409 }
      );
    }
  }

  // The partner keeps its figure. If it has no group yet, it starts one —
  // first member, nothing to adopt from, stock untouched.
  let groupId: string = partner.stock_group_id ?? randomUUID();
  if (!partner.stock_group_id) {
    const { error } = await admin.from("products").update({ stock_group_id: groupId }).eq("id", partnerId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  // The product joins it and, via the adopt trigger, takes the partner's
  // stock. Already there? Nothing to do.
  if (product.stock_group_id !== groupId) {
    const { error } = await admin.from("products").update({ stock_group_id: groupId }).eq("id", productId);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const { data: group, error: groupErr } = await admin
    .from("products")
    .select("id, sku, stock_on_hand")
    .eq("stock_group_id", groupId)
    .order("sku");
  if (groupErr) return NextResponse.json({ error: groupErr.message }, { status: 400 });

  return NextResponse.json({ ok: true, stockGroupId: groupId, members: group ?? [] });
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
