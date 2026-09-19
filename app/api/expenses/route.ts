import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { t } from "@/lib/i18n";

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
const NEEDS_MIGRATION = t("expense.salesmanNeedsMigration");

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
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
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
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const body = await req.json();
  // Only type/category/amount/date are required (§Expense) — description
  // and notes are optional, unlike the earlier build which also demanded a
  // description.
  const { type, category, description, amount, date, notes, salesman_id } = body;
  if (!type || !category || amount == null || !date) {
    return NextResponse.json({ error: t("expense.typeCategoryAmountDateRequired") }, { status: 400 });
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
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const body = await req.json();
  const { id, type, category, description, amount, date, notes, salesman_id } = body;
  if (!id) return NextResponse.json({ error: t("common.idRequired") }, { status: 400 });
  if (!type || !category || amount == null || !date) {
    return NextResponse.json({ error: t("expense.typeCategoryAmountDateRequired") }, { status: 400 });
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

// Remove-after-logging. A mistyped expense had no way out of the list: GET,
// POST and PATCH were the whole file, so the only correction available was
// to edit the row into something else. iOS has had a delete on the expense
// sheet (ExpenseView.swift, AddExpenseSheet.delete) since V5, and this is
// the same operation behind the same door.
//
// Same authorisation as PATCH — Manager or Admin, checked server-side, and
// routed through the service-role key for the same reason the rest of the
// file is (the `expenses` RLS policy still names the old users.auth_id
// column and 400s on every anon-key query).
//
// Hard delete, matching the phone: an expense is a manager's own note of
// money spent, not a ledger entry. The general ledger's reverse-never-delete
// rule (CLAUDE.md, Architecture) governs journal entries, which these are
// not, and the two apps must agree on what a delete does.
export async function DELETE(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  // Body, like PATCH. The query string is accepted too so the route can be
  // called from somewhere that cannot send a body on a DELETE.
  let id: string | undefined = new URL(req.url).searchParams.get("id") ?? undefined;
  if (!id) {
    const body = await req.json().catch(() => ({}));
    id = (body as { id?: string }).id;
  }
  if (!id) return NextResponse.json({ error: t("common.idRequired") }, { status: 400 });

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  // Ask for the row back. A delete that matched nothing reports success and
  // removes nothing, which would leave the screen claiming a row is gone
  // while the next load brings it straight back — the same trap the goal
  // save already guards against.
  const { data: removed, error } = await admin
    .from("expenses")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  if (!removed || removed.length === 0) {
    return NextResponse.json({ error: t("expense.noLongerExists") }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
