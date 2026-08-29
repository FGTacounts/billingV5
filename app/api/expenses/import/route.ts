import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

interface ImportRow {
  type?: string;
  category?: string;
  description?: string;
  amount?: number | string;
  date?: string;
  notes?: string;
}

// Manager-only bulk import (§Expense), mirroring the products/customers
// import routes. Only type/category/amount/date are required per row —
// matches the same relaxed validation as the single-expense POST route.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { rows } = (await req.json()) as { rows: ImportRow[] };
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "No rows to import" }, { status: 400 });
  }

  const VALID_TYPES = new Set(["fixed", "variable", "purchase"]);
  const clean = rows
    .map((r) => ({ ...r, type: r.type?.trim().toLowerCase(), category: r.category?.trim() }))
    .filter((r) => r.type && VALID_TYPES.has(r.type) && r.category && r.amount != null && r.amount !== "" && r.date)
    .map((r) => ({
      type: r.type as string,
      category: r.category as string,
      description: r.description?.trim() || null,
      amount: Number(r.amount) || 0,
      date: r.date as string,
      notes: r.notes?.trim() || null,
      logged_by: caller.id,
    }));

  if (clean.length === 0) {
    return NextResponse.json({ error: "Every row needs type (fixed/variable/purchase), category, amount, and date" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin.from("expenses").insert(clean);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, count: clean.length });
}
