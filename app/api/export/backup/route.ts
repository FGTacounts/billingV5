import { NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";

export const runtime = "nodejs";

// A local backup: the five datasets the phone puts in one JSON file
// (SettingsView.swift, `BackupExportRow`) — customers, products, orders,
// payments and expenses — handed back as a download with the day's date in
// the name.
//
// Manager-only, like every other export here (§11: "only Manager can export
// Excel"). Read through supabaseCaller(), never service-role: a backup is a
// copy of what the person asking already has, and RLS decides what that is.
// A service-role read would quietly widen the file to rows they cannot see
// anywhere else in the app.
//
// Cost is left out of the products list for the same reason the phone leaves
// it out: it is a manager-only figure the signed-in session is not given, and
// asking for it fails the whole request rather than returning less.

interface Dataset {
  key: string;
  table: string;
  columns: string;
  orderBy?: string;
}

const DATASETS: Dataset[] = [
  {
    key: "customers",
    table: "customers",
    columns: "id, name, code, district, address, phone, vat_number, is_active",
    orderBy: "name",
  },
  {
    key: "products",
    table: "products",
    // `description` is the live column behind what the app calls a product's
    // name, and the category column really is capitalised in the schema.
    columns:
      'id, sku, description, price, stock_on_hand, default_qty, rack_location, "Product_category", is_active',
    orderBy: "sku",
  },
  {
    key: "orders",
    table: "orders",
    columns:
      "id, invoice_number, status, salesman_id, customer_id, subtotal, vat_amount, total, created_at",
    orderBy: "created_at",
  },
  {
    key: "payments",
    table: "payments",
    columns: "id, customer_id, amount, status, notes, created_at",
    orderBy: "created_at",
  },
  {
    key: "expenses",
    table: "expenses",
    // `expenses` has no created_at — asking for one fails the request and the
    // backup comes back with no expenses in it at all.
    columns: "id, category, amount, description, date, updated_at",
    orderBy: "date",
  },
];

export async function GET() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const supabase = supabaseCaller();

  const results = await Promise.all(
    DATASETS.map(async (set) => {
      let query = supabase.from(set.table).select(set.columns);
      if (set.orderBy) query = query.order(set.orderBy);
      const { data, error } = await query;
      return { set, data, error };
    })
  );

  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json(
      { error: `Couldn't read ${failed.set.key}: ${failed.error.message}` },
      { status: 400 }
    );
  }

  const backup: Record<string, unknown> = {
    // UTC, like every other timestamp this app writes.
    exportedAt: new Date().toISOString(),
  };
  for (const r of results) backup[r.set.key] = r.data ?? [];

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="famlist_backup_${stamp}.json"`,
    },
  });
}
