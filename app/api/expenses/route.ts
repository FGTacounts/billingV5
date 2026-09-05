import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// `expenses.salesman_id` arrives with scratchpad/RUN-ME-8. Until that has
// been run the column is absent, so every read falls back to one without it
// and a write that does not name a salesman still works — only an attempt
// to actually attribute an expense says what is missing.
// Two different shapes for the same absence: a select names an unknown
// column and Postgres answers 42703; an insert or update names one and
// PostgREST answers PGRST204 out of its schema cache.
function isMissingSalesmanColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    (error.message ?? "").includes("salesman_id")
  );
}
let salesmanColumnMissing = false;

const EXPENSE_COLUMNS = "id, type, category, amount, description, notes, date, logged_by";
// Worded to survive friendlyError untouched — it rewrites anything that
// mentions a column or a schema cache into a generic apology.
const NEEDS_MIGRATION =
  "Naming a salesman on an expense needs the RUN-ME-8 file run in Supabase first.";

// Manager-only, and routed through the service-role key rather than the
// browser's anon-key RLS path: the `expenses` RLS policy still references
// the old `users.auth_id` column (renamed to `auth_user_id` in a later
// schema revision) and 400s on every anon-key query — a DB-side bug that
// can't be fixed from here without SQL/dashboard access. This also happens
// to be the spec-correct shape anyway (§4: Expense must be blocked
// server-side, not just hidden client-side).
export async function GET(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type");

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const read = async (columns: string) => {
    let q = admin.from("expenses").select(columns).order("date", { ascending: false });
    if (type) q = q.eq("type", type);
    return q;
  };

  if (!salesmanColumnMissing) {
    const { data, error } = await read(`${EXPENSE_COLUMNS}, salesman_id`);
    if (!error) return NextResponse.json({ expenses: data ?? [] });
    if (!isMissingSalesmanColumn(error)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    salesmanColumnMissing = true;
  }

  const { data, error } = await read(EXPENSE_COLUMNS);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ expenses: data ?? [], salesmanSupported: false });
}

export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const body = await req.json();
  // Only type/category/amount/date are required (§Expense) — description
  // and notes are optional, unlike the earlier build which also demanded a
  // description.
  const { type, category, description, amount, date, notes, salesman_id } = body;
  if (!type || !category || amount == null || !date) {
    return NextResponse.json({ error: "type, category, amount, date are required" }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const row = {
    type,
    category,
    description: description || null,
    amount,
    date,
    notes: notes || null,
    logged_by: caller.id,
    // Whose expense it is, which is a different question from who typed it
    // in (logged_by, always a manager — logging is manager-gated). Null is
    // meaningful: rent belongs to the business, not to a person.
    ...(salesman_id ? { salesman_id } : {}),
  };

  const { error } = await admin.from("expenses").insert(row);
  if (error) {
    if (isMissingSalesmanColumn(error) && salesman_id) {
      salesmanColumnMissing = true;
      return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 501 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}

// Edit-after-logging (§Expense: "unable to edit the items after logging").
export async function PATCH(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const body = await req.json();
  const { id, type, category, description, amount, date, notes, salesman_id } = body;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  if (!type || !category || amount == null || !date) {
    return NextResponse.json({ error: "type, category, amount, date are required" }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const patch: Record<string, unknown> = {
    type,
    category,
    description: description || null,
    amount,
    date,
    notes: notes || null,
  };
  // undefined means "the caller did not touch it"; null means "clear it".
  if (salesman_id !== undefined) patch.salesman_id = salesman_id || null;

  const { error } = await admin.from("expenses").update(patch).eq("id", id);
  if (error) {
    if (isMissingSalesmanColumn(error) && salesman_id !== undefined) {
      salesmanColumnMissing = true;
      return NextResponse.json({ error: NEEDS_MIGRATION }, { status: 501 });
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
