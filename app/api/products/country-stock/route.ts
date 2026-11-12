import { NextRequest, NextResponse } from "next/server";
import { t } from "@/lib/i18n";
import { supabaseCaller } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Stock held in other countries (scratchpad/RUN-ME-41). The UAE stock stays
// products.stock_on_hand; this is a list per SKU of overseas warehouses
// ("India · Warehouse 1") and how many are in each, plus moving stock
// between any two of them and the UAE.
//
// Managers and admins only (owner, 2026-11-13). Everything runs as the
// caller — never the service key — and the database functions check the
// role themselves, so the phone can call the same route with its Bearer
// token and get the same answer.
//
// SKUs sharing stock carry one overseas figure; combos sell from the UAE
// only and hold none. Both rules live in the database.

/** The functions are not there yet: RUN-ME-41 has not been run. */
function notRun(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  if (e.code === "PGRST202") return true;
  return /warehouse|move_stock|overseas_stock_totals/.test(e.message ?? "") && /does not exist|Could not find/.test(e.message ?? "");
}

function refusal(e: { code?: string; message?: string }): string {
  const m = e.message ?? "";
  if (m.includes("WAREHOUSE_MANAGER_ONLY") || e.code === "42501") return t("common.managerAccessRequired");
  if (m.includes("WAREHOUSE_COMBO")) return t("countryStock.comboUaeOnly");
  if (m.includes("WAREHOUSE_QTY")) return t("countryStock.qtyInvalid");
  if (m.includes("WAREHOUSE_UNKNOWN")) return t("countryStock.unknownWarehouse");
  if (m.includes("STOCK_MOVE_SAME")) return t("countryStock.moveSamePlace");
  if (m.includes("STOCK_MOVE_UAE_UNCOUNTED")) return t("countryStock.uaeUncounted");
  if (m.includes("STOCK_MOVE_SHORT")) {
    const have = /only (\d+)/.exec(m)?.[1] ?? "0";
    return t("countryStock.moveShort", { have });
  }
  if (m.includes("stock_warehouses_country_len") || m.includes("stock_warehouses_name_len")) {
    return t("countryStock.warehouseNameInvalid");
  }
  if (notRun(e)) return t("countryStock.notEnabled");
  return m || t("countryStock.failed");
}

function failed(e: { code?: string; message?: string }) {
  const status = e.code === "42501" || (e.message ?? "").includes("WAREHOUSE_MANAGER_ONLY") ? 403 : 400;
  return NextResponse.json({ error: refusal(e) }, { status });
}

type Row = { warehouse_id: string; country: string; name: string; qty: number };
type Warehouse = { id: string; country: string; name: string };

const MAX_QTY = 10_000_000;

function validQty(n: unknown, allowZero: boolean): n is number {
  return typeof n === "number" && Number.isInteger(n) && n <= MAX_QTY && (allowZero ? n >= 0 : n > 0);
}

async function answer(supabase: ReturnType<typeof supabaseCaller>, productId: string) {
  const [rows, warehouses, product] = await Promise.all([
    supabase.rpc("warehouse_stock_for", { p_product: productId }),
    supabase.rpc("list_stock_warehouses"),
    supabase.from("products").select("stock_on_hand").eq("id", productId).maybeSingle(),
  ]);
  if (rows.error && notRun(rows.error)) {
    return NextResponse.json({ ready: false, rows: [], warehouses: [], uae: null });
  }
  if (rows.error) return failed(rows.error);
  if (warehouses.error) return failed(warehouses.error);
  return NextResponse.json({
    ready: true,
    rows: (rows.data ?? []) as Row[],
    warehouses: (warehouses.data ?? []) as Warehouse[],
    uae: (product.data?.stock_on_hand as number | null | undefined) ?? null,
  });
}

// ?productId=  → { ready, rows, warehouses, uae }
// ?totals=1    → { ready, totals: { [productId]: n } } for the Products list
// ?warehouses=1 → { ready, warehouses }
export async function GET(req: NextRequest) {
  const supabase = supabaseCaller();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  // ?warehouses=1 → every overseas warehouse, for the "Stock from" picker
  // on a new order or an import (RUN-ME-42).
  if (req.nextUrl.searchParams.get("warehouses")) {
    const { data, error } = await supabase.rpc("list_stock_warehouses");
    if (error) {
      if (notRun(error)) return NextResponse.json({ ready: false, warehouses: [] });
      return failed(error);
    }
    return NextResponse.json({ ready: true, warehouses: (data ?? []) as Warehouse[] });
  }

  if (req.nextUrl.searchParams.get("totals")) {
    const { data, error } = await supabase.rpc("overseas_stock_totals");
    if (error) {
      if (notRun(error)) return NextResponse.json({ ready: false, totals: {} });
      return failed(error);
    }
    const totals: Record<string, number> = {};
    for (const r of (data ?? []) as { product_id: string; total: number }[]) totals[r.product_id] = r.total;
    return NextResponse.json({ ready: true, totals });
  }

  const productId = req.nextUrl.searchParams.get("productId");
  if (!productId) return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });
  return answer(supabase, productId);
}

// { action: "set", productId, warehouseId | { country, name }, qty }
//   → sets this SKU's figure in that warehouse, adding the warehouse first
//     when it is new.
// { action: "move", productId, from, to, qty }  (null = UAE)
//   → moves stock between two places in one database transaction.
export async function POST(req: NextRequest) {
  const supabase = supabaseCaller();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    productId?: string;
    warehouseId?: string | null;
    country?: string;
    name?: string;
    qty?: unknown;
    from?: string | null;
    to?: string | null;
  };
  const productId = body.productId;
  if (!productId) return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });

  if (body.action === "set") {
    if (!validQty(body.qty, true)) return NextResponse.json({ error: t("countryStock.qtyInvalid") }, { status: 400 });
    let warehouseId = body.warehouseId ?? null;
    if (!warehouseId) {
      const country = (body.country ?? "").trim();
      const name = (body.name ?? "").trim();
      if (!country || !name) {
        return NextResponse.json({ error: t("countryStock.warehouseNameInvalid") }, { status: 400 });
      }
      const added = await supabase.rpc("add_stock_warehouse", { p_country: country, p_name: name });
      if (added.error) return failed(added.error);
      warehouseId = added.data as string;
    }
    const { error } = await supabase.rpc("set_warehouse_stock", {
      p_product: productId,
      p_warehouse: warehouseId,
      p_qty: body.qty,
    });
    if (error) return failed(error);
    return answer(supabase, productId);
  }

  if (body.action === "move") {
    if (!validQty(body.qty, false)) return NextResponse.json({ error: t("countryStock.qtyInvalid") }, { status: 400 });
    const { error } = await supabase.rpc("move_stock", {
      p_product: productId,
      p_from: body.from ?? null,
      p_to: body.to ?? null,
      p_qty: body.qty,
    });
    if (error) return failed(error);
    return answer(supabase, productId);
  }

  return NextResponse.json({ error: t("countryStock.failed") }, { status: 400 });
}

// { productId, warehouseId } → takes that warehouse off this SKU.
export async function DELETE(req: NextRequest) {
  const supabase = supabaseCaller();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const { productId, warehouseId } = (await req.json().catch(() => ({}))) as {
    productId?: string;
    warehouseId?: string;
  };
  if (!productId || !warehouseId) {
    return NextResponse.json({ error: t("products.productIdRequired") }, { status: 400 });
  }
  const { error } = await supabase.rpc("remove_warehouse_stock", { p_product: productId, p_warehouse: warehouseId });
  if (error) return failed(error);
  return answer(supabase, productId);
}
