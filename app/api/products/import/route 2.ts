import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { cleanDashPlaceholder, dedupeSkus } from "@/lib/importAliases";

export const runtime = "nodejs";

// Raw row shape as parsed from the uploaded sheet — header names vary by
// source (§Products: "support for all kinds of spreadsheet formats"), so
// the client normalizes headers before posting here, but we still accept
// both `name` and `description` as aliases since older exports use `name`.
interface ImportRow {
  sku?: string;
  name?: string;
  description?: string;
  category?: string;
  price?: number | string;
  cost?: number | string;
  default_qty?: number | string;
  barcode?: string | null;
  rack_location?: string | null;
  is_active?: boolean | string;
  stock_on_hand?: number | string;
}

// Manager-only bulk import (§Products) — service-role so the write goes
// through regardless of the caller's own RLS-restricted column access,
// same reasoning as every other write route in this app. Upserts on `sku`
// (the natural unique key) rather than inserting blind, so re-importing an
// updated price list corrects existing rows instead of duplicating them.
//
// Only sku + description are required to accept a row (§Products: "if the
// user doesn't fill in all data, only require the essential items... the
// rest can be done by auto") — price/cost/stock default to 0, default_qty
// to 12 (matching the product editor's own default), category/rack/barcode
// to null, is_active to true.
//
// Those defaults are for a NEW product. For a SKU we already hold, a column
// the sheet leaves out — or a cell it leaves blank — keeps the value we have:
// a sheet of SKUs and new stock counts must not reset every price to zero.
// (Stock already worked this way; the rest of the columns now do too.)
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { rows, stockMode = "keep" } = (await req.json()) as {
    rows: ImportRow[];
    // What to do with stock on SKUs that already exist:
    //   keep    leave the stock we already have (safe default)
    //   replace use the number in the file
    //   add     add the file's number to what is already there
    stockMode?: "keep" | "replace" | "add";
  };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: t("products.noRowsToImport") }, { status: 400 });
  }

  const stated = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";
  const clean = dedupeSkus(
    rows
      .map((r) => ({ ...r, sku: r.sku?.trim(), description: (r.description ?? r.name)?.trim() }))
      .filter((r): r is ImportRow & { sku: string; description: string } => !!(r.sku && r.description))
      .map((r) => ({
        sku: r.sku,
        description: r.description,
        // null on every optional column below means "the sheet did not say".
        Product_category: stated(r.category) ? String(r.category).trim() : null,
        price: stated(r.price) ? Number(r.price) || 0 : null,
        cost: stated(r.cost) ? Number(r.cost) || 0 : null,
        default_qty: stated(r.default_qty) ? Number(r.default_qty) || 12 : null,
        barcode: stated(r.barcode) ? String(r.barcode).trim() : null,
        // A lone "-" is this catalog's placeholder for "no rack" (§Products
        // schema notes) — treat it as no value, not the literal text "-".
        rack_location: cleanDashPlaceholder(r.rack_location) || null,
        is_active: stated(r.is_active)
          ? !["false", "no", "0", "inactive"].includes(String(r.is_active).trim().toLowerCase())
          : null,
        // The old code wrote 0 for a blank cell, so importing a price list
        // with no stock column silently zeroed the whole catalogue.
        stock_on_hand: stated(r.stock_on_hand) ? Number(r.stock_on_hand) || 0 : null,
      }))
  );

  if (clean.length === 0) {
    return NextResponse.json({ error: t("products.rowsNeedSkuAndDescription") }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Look up what we already hold for these SKUs, so an import can top stock
  // up rather than overwrite it, and so a blank stock cell leaves the
  // existing quantity alone instead of zeroing it.
  const skus = clean.map((r) => r.sku);
  const existingStock = new Map<string, number>();
  type Held = {
    sku: string;
    stock_on_hand: number | null;
    Product_category: string | null;
    price: number;
    cost: number;
    default_qty: number;
    barcode: string | null;
    rack_location: string | null;
    is_active: boolean;
  };
  const held = new Map<string, Held>();
  for (let i = 0; i < skus.length; i += 500) {
    const { data } = await admin
      .from("products")
      .select('sku, stock_on_hand, "Product_category", price, cost, default_qty, barcode, rack_location, is_active')
      .in("sku", skus.slice(i, i + 500));
    for (const row of (data ?? []) as unknown as Held[]) {
      existingStock.set(row.sku, row.stock_on_hand ?? 0);
      held.set(row.sku, row);
    }
  }

  const payload = clean.map((r) => {
    const known = existingStock.get(r.sku);
    const isNew = known === undefined;
    const fromFile = r.stock_on_hand;

    let stock: number;
    if (isNew) {
      stock = fromFile ?? 0;
    } else if (fromFile == null) {
      stock = known; // file said nothing — keep what we have
    } else if (stockMode === "add") {
      stock = known + fromFile;
    } else if (stockMode === "replace") {
      stock = fromFile;
    } else {
      stock = known; // "keep"
    }
    // What the sheet did not say: what we already hold for this SKU, or the
    // new-product default.
    const was = held.get(r.sku);
    // Never negative — an "add" of a negative cell, or a replace with one,
    // settles at zero.
    return {
      sku: r.sku,
      description: r.description,
      Product_category: r.Product_category ?? was?.Product_category ?? null,
      price: r.price ?? was?.price ?? 0,
      // cost is NOT NULL on this table (confirmed live) — null would
      // violate the constraint and fail the whole row.
      cost: r.cost ?? was?.cost ?? 0,
      default_qty: r.default_qty ?? was?.default_qty ?? 12,
      barcode: r.barcode ?? was?.barcode ?? null,
      rack_location: r.rack_location ?? was?.rack_location ?? null,
      is_active: r.is_active ?? was?.is_active ?? true,
      stock_on_hand: Math.max(0, stock),
    };
  });

  const { error } = await admin.from("products").upsert(payload, { onConflict: "sku" });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const updated = clean.filter((r) => existingStock.has(r.sku)).length;
  return NextResponse.json({
    ok: true,
    count: clean.length,
    created: clean.length - updated,
    updated,
  });
}
