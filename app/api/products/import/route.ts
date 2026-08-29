import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
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
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
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
    return NextResponse.json({ error: "No rows to import" }, { status: 400 });
  }

  const clean = dedupeSkus(
    rows
      .map((r) => ({ ...r, sku: r.sku?.trim(), description: (r.description ?? r.name)?.trim() }))
      .filter((r): r is ImportRow & { sku: string; description: string } => !!(r.sku && r.description))
      .map((r) => ({
        sku: r.sku,
        description: r.description,
        Product_category: r.category?.trim() || null,
        price: r.price != null && r.price !== "" ? Number(r.price) || 0 : 0,
        // cost is NOT NULL on this table (confirmed live) — null would
        // violate the constraint and fail the whole row.
        cost: r.cost != null && r.cost !== "" ? Number(r.cost) || 0 : 0,
        default_qty: r.default_qty != null && r.default_qty !== "" ? Number(r.default_qty) || 12 : 12,
        barcode: r.barcode || null,
        // A lone "-" is this catalog's placeholder for "no rack" (§Products
        // schema notes) — treat it as no value, not the literal text "-".
        rack_location: cleanDashPlaceholder(r.rack_location) || null,
        is_active: r.is_active === undefined || r.is_active === "" ? true : String(r.is_active).toLowerCase() !== "false",
        // null means "the file did not say", which is different from zero.
        // The old code wrote 0 for a blank cell, so importing a price list
        // with no stock column silently zeroed the whole catalogue.
        stock_on_hand:
          r.stock_on_hand != null && r.stock_on_hand !== "" ? Number(r.stock_on_hand) || 0 : null,
      }))
  );

  if (clean.length === 0) {
    return NextResponse.json({ error: "Every row needs at least a SKU and description" }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Look up what we already hold for these SKUs, so an import can top stock
  // up rather than overwrite it, and so a blank stock cell leaves the
  // existing quantity alone instead of zeroing it.
  const skus = clean.map((r) => r.sku);
  const existingStock = new Map<string, number>();
  for (let i = 0; i < skus.length; i += 500) {
    const { data } = await admin
      .from("products")
      .select("sku, stock_on_hand")
      .in("sku", skus.slice(i, i + 500));
    for (const row of data ?? []) existingStock.set(row.sku, row.stock_on_hand ?? 0);
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
    return { ...r, stock_on_hand: stock };
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
