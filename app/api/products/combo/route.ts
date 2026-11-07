import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { comboTableMissing } from "@/lib/combos-server";

export const runtime = "nodejs";

// Combos (scratchpad/RUN-ME-39): a product sold as one of each of several
// other products. The database keeps the combo's stock at the lowest of its
// parts and moves every part when a combo is sold or given back; this route
// only says which products a combo is made of.
//
// Reading is open to anyone signed in — it is not a cost figure, and whoever
// may see the stock may see where it comes from. Changing it is manager-only,
// like every other product edit.

type Part = { id: string; sku: string; stock_on_hand: number | null };

function notReady(message: string | undefined) {
  return comboTableMissing(message) ? t("products.comboNotEnabled") : message ?? "";
}

async function partsOf(admin: ReturnType<typeof supabaseAdmin>, comboId: string) {
  const { data, error } = await admin
    .from("product_combo_parts")
    .select("part:products!product_combo_parts_part_id_fkey(id, sku, stock_on_hand)")
    .eq("combo_id", comboId);
  if (error) return { error: error.message };
  const parts = (data ?? [])
    .map((r) => r.part as unknown as Part | null)
    .filter((p): p is Part => p != null)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return { parts };
}

async function managerOrRefuse() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }
  return null;
}

// ?productId= → the parts it is made of, and the combos it is a part of.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });
  const productId = req.nextUrl.searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });

  const admin = supabaseAdmin();
  const own = await partsOf(admin, productId);
  if (own.error !== undefined) {
    // Not run yet: nothing is a combo, and the page carries on.
    if (comboTableMissing(own.error)) return NextResponse.json({ parts: [], partOf: [], ready: false });
    return NextResponse.json({ error: own.error }, { status: 400 });
  }
  const { data: inCombos, error } = await admin
    .from("product_combo_parts")
    .select("combo:products!product_combo_parts_combo_id_fkey(id, sku, stock_on_hand)")
    .eq("part_id", productId);
  if (error) return NextResponse.json({ error: notReady(error.message) }, { status: 400 });
  const partOf = (inCombos ?? [])
    .map((r) => r.combo as unknown as Part | null)
    .filter((p): p is Part => p != null)
    .sort((a, b) => a.sku.localeCompare(b.sku));
  return NextResponse.json({ parts: own.parts, partOf, ready: true });
}

// { comboId, partId } → adds one part. The combo's stock becomes the lowest
// of its parts at once (database trigger).
export async function POST(req: NextRequest) {
  const refused = await managerOrRefuse();
  if (refused) return refused;

  const { comboId, partId } = (await req.json()) as { comboId?: string; partId?: string };
  if (!comboId || !partId) {
    return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });
  }
  if (comboId === partId) {
    return NextResponse.json({ error: t("products.comboCannotContainItself") }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: rows, error: readErr } = await admin
    .from("products")
    .select("id, sku, stock_group_id")
    .in("id", [comboId, partId]);
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  const combo = rows?.find((r) => r.id === comboId);
  const part = rows?.find((r) => r.id === partId);
  if (!combo || !part) return NextResponse.json({ error: t("products.notFound") }, { status: 404 });

  // One level only, and a combo has no shelf to share. The database checks
  // the same things (the phone writes tables directly); asking here first
  // gives the person a sentence instead of a constraint name.
  if (combo.stock_group_id) {
    return NextResponse.json({ error: t("products.comboCannotShareStock") }, { status: 400 });
  }
  const { data: links, error: linkErr } = await admin
    .from("product_combo_parts")
    .select("combo_id, part_id")
    .or(`combo_id.eq.${partId},part_id.eq.${comboId}`)
    .limit(1);
  if (linkErr) return NextResponse.json({ error: notReady(linkErr.message) }, { status: 400 });
  if ((links ?? []).some((l) => l.combo_id === partId)) {
    return NextResponse.json({ error: t("products.comboPartIsCombo", { sku: part.sku }) }, { status: 400 });
  }
  if ((links ?? []).some((l) => l.part_id === comboId)) {
    return NextResponse.json({ error: t("products.comboIsAPart", { sku: combo.sku }) }, { status: 400 });
  }

  const { error } = await admin
    .from("product_combo_parts")
    .upsert({ combo_id: comboId, part_id: partId }, { onConflict: "combo_id,part_id", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: notReady(error.message) }, { status: 400 });

  const after = await partsOf(admin, comboId);
  if (after.error !== undefined) return NextResponse.json({ error: notReady(after.error) }, { status: 400 });
  const { data: fresh } = await admin.from("products").select("stock_on_hand").eq("id", comboId).maybeSingle();
  return NextResponse.json({ ok: true, parts: after.parts, comboStock: fresh?.stock_on_hand ?? null });
}

// { comboId, partId } → removes one part. Removing the last one makes it an
// ordinary product again, holding the figure it had at that moment.
export async function DELETE(req: NextRequest) {
  const refused = await managerOrRefuse();
  if (refused) return refused;

  const { comboId, partId } = (await req.json()) as { comboId?: string; partId?: string };
  if (!comboId || !partId) {
    return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });
  }
  const admin = supabaseAdmin();
  const { error } = await admin
    .from("product_combo_parts")
    .delete()
    .eq("combo_id", comboId)
    .eq("part_id", partId);
  if (error) return NextResponse.json({ error: notReady(error.message) }, { status: 400 });

  const after = await partsOf(admin, comboId);
  if (after.error !== undefined) return NextResponse.json({ error: notReady(after.error) }, { status: 400 });
  const { data: fresh } = await admin.from("products").select("stock_on_hand").eq("id", comboId).maybeSingle();
  return NextResponse.json({ ok: true, parts: after.parts, comboStock: fresh?.stock_on_hand ?? null });
}
