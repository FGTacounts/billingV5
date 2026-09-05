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
  // Whose expense it is, written as a name. Optional — an expense that
  // belongs to the business names nobody.
  salesman?: string;
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

  const admin = supabaseAdmin();

  // Names in the file are matched against the staff list, so an imported
  // expense is linked to a real person rather than to a spelling.
  const { data: staff } = await admin.from("users").select("id, full_name").eq("is_active", true);
  const idByName = new Map<string, string>();
  for (const u of staff ?? []) idByName.set(String(u.full_name).trim().toLowerCase(), u.id as string);
  const unknownNames = new Set<string>();

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
      salesman: r.salesman?.trim() || "",
    }));

  if (clean.length === 0) {
    return NextResponse.json({ error: "Every row needs type (fixed/variable/purchase), category, amount, and date" }, { status: 400 });
  }

  const rowsToInsert = clean.map(({ salesman, ...rest }) => {
    if (!salesman) return rest;
    const id = idByName.get(salesman.toLowerCase());
    if (!id) {
      unknownNames.add(salesman);
      return rest;
    }
    return { ...rest, salesman_id: id };
  });

  let { error } = await admin.from("expenses").insert(rowsToInsert);
  // The salesman_id column arrives with RUN-ME-8. Without it the import
  // still lands — the expenses just aren't attributed to anyone yet.
  let attributionDropped = false;
  if (error && (error.code === "42703" || error.code === "PGRST204" || error.message.includes("salesman_id"))) {
    attributionDropped = rowsToInsert.some((r) => "salesman_id" in r);
    ({ error } = await admin
      .from("expenses")
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      .insert(rowsToInsert.map(({ salesman_id, ...rest }: Record<string, unknown>) => rest)));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const notes: string[] = [];
  if (unknownNames.size > 0) {
    notes.push(`No staff member named ${[...unknownNames].join(", ")} — those rows were left unattributed.`);
  }
  if (attributionDropped) {
    notes.push("Salesman attribution needs scratchpad/RUN-ME-8-stock-floor-and-salesman-expenses.sql to be run.");
  }

  return NextResponse.json({ ok: true, count: clean.length, ...(notes.length ? { note: notes.join(" ") } : {}) });
}
