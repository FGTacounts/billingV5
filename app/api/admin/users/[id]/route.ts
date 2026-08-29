import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { name, role, active, password } = await req.json();

  // Self-protection: don't let a Manager/Admin lock themselves out by
  // deactivating their own account or demoting themselves to a role
  // without Settings access — swapping between manager <-> admin is fine.
  if (params.id === caller.id && (active === false || (role && role !== "manager" && role !== "admin"))) {
    return NextResponse.json(
      { error: "You can't deactivate or change your own role." },
      { status: 400 }
    );
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  // Admin is above Manager (§Global: "the manager can not control the
  // admin") — a Manager can't touch an existing Admin's account at all, and
  // granting Admin access to anyone (including promoting themselves) is
  // Admin-only.
  if (caller.role !== "admin") {
    const { data: target } = await admin.from("users").select("role").eq("id", params.id).maybeSingle();
    if (target?.role === "admin") {
      return NextResponse.json({ error: "Only an Admin can modify another Admin's account." }, { status: 403 });
    }
    if (role === "admin") {
      return NextResponse.json({ error: "Only an Admin can grant Admin access." }, { status: 403 });
    }
  }

  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.full_name = name;
  if (role !== undefined) patch.role = role;
  if (active !== undefined) patch.is_active = active;

  if (Object.keys(patch).length) {
    const { error } = await admin.from("users").update(patch).eq("id", params.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  }

  if (password) {
    const { data: row } = await admin.from("users").select("auth_user_id").eq("id", params.id).maybeSingle();
    if (row?.auth_user_id) {
      const { error } = await admin.auth.admin.updateUserById(row.auth_user_id, { password });
      if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  if (params.id === caller.id) {
    return NextResponse.json({ error: "You can't remove your own account." }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { data: row, error: findErr } = await admin
    .from("users")
    .select("auth_user_id, role")
    .eq("id", params.id)
    .maybeSingle();
  if (findErr || !row) return NextResponse.json({ error: "User not found" }, { status: 404 });
  // Admin is above Manager — a Manager can't remove an Admin's account.
  if (row.role === "admin" && caller.role !== "admin") {
    return NextResponse.json({ error: "Only an Admin can remove another Admin's account." }, { status: 403 });
  }

  const { error: deleteErr } = await admin.from("users").delete().eq("id", params.id);
  if (deleteErr) {
    // Most likely a foreign-key reference from orders/payments/etc — those
    // records shouldn't silently lose their salesman/collector, so we don't
    // force it. Deactivating keeps history intact instead.
    return NextResponse.json(
      {
        error:
          "Couldn't remove this user — they're likely referenced by existing orders or payments. Deactivate them instead to preserve history.",
      },
      { status: 409 }
    );
  }

  await admin.auth.admin.deleteUser(row.auth_user_id);
  return NextResponse.json({ ok: true });
}
