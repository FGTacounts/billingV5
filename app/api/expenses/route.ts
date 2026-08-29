import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

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

  let q = admin
    .from("expenses")
    .select("id, type, category, amount, description, notes, date, logged_by")
    .order("date", { ascending: false });
  if (type) q = q.eq("type", type);

  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ expenses: data ?? [] });
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
  const { type, category, description, amount, date, notes } = body;
  if (!type || !category || amount == null || !date) {
    return NextResponse.json({ error: "type, category, amount, date are required" }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { error } = await admin.from("expenses").insert({
    type,
    category,
    description: description || null,
    amount,
    date,
    notes: notes || null,
    logged_by: caller.id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// Edit-after-logging (§Expense: "unable to edit the items after logging").
export async function PATCH(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const body = await req.json();
  const { id, type, category, description, amount, date, notes } = body;
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

  const { error } = await admin
    .from("expenses")
    .update({ type, category, description: description || null, amount, date, notes: notes || null })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}
