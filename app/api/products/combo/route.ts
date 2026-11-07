import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { comboRefusal, comboTableMissing, shelfMembers } from "@/lib/combos-server";

export const runtime = "nodejs";

// Combos (scratchpad/RUN-ME-39): a product sold as one of each of several
// other products. The database keeps a combo's stock at the lowest of its
// parts and moves every part when a combo is sold or given back; this route
// only says which products a combo is made of.
//
// A combo can be sold under several SKUs: they share stock (RUN-ME-18) and
// are one combo shelf. So everything here works on the SHELF the product is
// on — its parts are the parts of every combo on that shelf, and taking a
// part out takes it out wherever on the shelf it was added.
//
// Reading is open to anyone signed in — it is not a cost figure, and whoever
// may see the stock may see where it comes from. Changing it is manager-only,
// like every other product edit.

type Member = { id: string; sku: string; stock_on_hand: number | null };
type Admin = ReturnType<typeof supabaseAdmin>;

function bySku(a: Member, b: Member) {
  return a.sku.localeCompare(b.sku);
}

async function productsById(admin: Admin, ids: string[]): Promise<Member[]> {
  if (ids.length === 0) return [];
  const { data, error } = await admin.from("products").select("id, sku, stock_on_hand").in("id", ids);
  if (error) throw new Error(error.message);
  return (data ?? []) as Member[];
}

/** The parts of the combo shelf `productId` is on, and the combos it is in. */
async function comboOf(admin: Admin, productId: string) {
  const shelf = (await shelfMembers(admin, productId)).map((m) => m.id);
  if (shelf.length === 0) return { parts: [] as Member[], partOf: [] as Member[], shelf };
  const { data: own, error } = await admin
    .from("product_combo_parts")
    .select("part_id")
    .in("combo_id", shelf);
  if (error) throw new Error(error.message);
  const { data: inCombos, error: e2 } = await admin
    .from("product_combo_parts")
    .select("combo_id")
    .in("part_id", shelf);
  if (e2) throw new Error(e2.message);
  const parts = await productsById(admin, [...new Set((own ?? []).map((r) => r.part_id as string))]);
  const partOf = await productsById(admin, [...new Set((inCombos ?? []).map((r) => r.combo_id as string))]);
  return { parts: parts.sort(bySku), partOf: partOf.sort(bySku), shelf };
}

async function answer(admin: Admin, productId: string) {
  const { parts } = await comboOf(admin, productId);
  const { data: fresh } = await admin.from("products").select("stock_on_hand").eq("id", productId).maybeSingle();
  return NextResponse.json({ ok: true, parts, comboStock: fresh?.stock_on_hand ?? null });
}

async function managerOrRefuse() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }
  return null;
}

function failed(e: unknown, status = 400) {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: comboRefusal(message) }, { status });
}

// ?productId= → the parts of its combo shelf, and the combos it is a part of.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });
  const productId = req.nextUrl.searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });

  try {
    const { parts, partOf } = await comboOf(supabaseAdmin(), productId);
    return NextResponse.json({ parts, partOf, ready: true });
  } catch (e) {
    // Not run yet: nothing is a combo, and the page carries on.
    if (comboTableMissing(e instanceof Error ? e.message : String(e))) {
      return NextResponse.json({ parts: [], partOf: [], ready: false });
    }
    return failed(e);
  }
}

// { comboId, partId } → adds one part. Every SKU on the combo's shelf takes
// the lowest part's figure at once (database trigger).
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

  // One level of combo. The database refuses the rest (a combo inside a
  // combo, a part that is a combo's own SKU) and comboRefusal() turns its
  // answer into a sentence.
  const admin = supabaseAdmin();
  const { error } = await admin
    .from("product_combo_parts")
    .upsert({ combo_id: comboId, part_id: partId }, { onConflict: "combo_id,part_id", ignoreDuplicates: true });
  if (error) return failed(new Error(error.message));
  try {
    return await answer(admin, comboId);
  } catch (e) {
    return failed(e);
  }
}

// { comboId, partId } → takes one part out of the combo shelf `comboId` is
// on, from whichever of its SKUs it was added to. Taking the last one out
// makes it ordinary shared stock, holding the figure it had at that moment.
export async function DELETE(req: NextRequest) {
  const refused = await managerOrRefuse();
  if (refused) return refused;

  const { comboId, partId } = (await req.json()) as { comboId?: string; partId?: string };
  if (!comboId || !partId) {
    return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });
  }
  const admin = supabaseAdmin();
  try {
    const shelf = (await shelfMembers(admin, comboId)).map((m) => m.id);
    const { error } = await admin
      .from("product_combo_parts")
      .delete()
      .in("combo_id", shelf.length > 0 ? shelf : [comboId])
      .eq("part_id", partId);
    if (error) throw new Error(error.message);
    return await answer(admin, comboId);
  } catch (e) {
    return failed(e);
  }
}
