import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Manager/Admin-only: create a Salesman/Warehouse/Manager/Admin account.
// Supabase Auth needs an email internally, so we map username -> a
// synthetic address (§4) and never surface "email" in the UI.
//
// The Admin role is above Manager (§Global: "The admin is the user who is
// in control of everything... the manager can not control the admin") — a
// Manager can create/manage Salesman/Warehouse/Manager accounts, but only
// an existing Admin can grant Admin access to anyone, including themselves.
export async function POST(req: NextRequest) {
  const caller = await getAppUser();
  if (!caller || (caller.role !== "manager" && caller.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { username, name, password, role } = await req.json();
  if (!username || !name || !password || !role) {
    return NextResponse.json({ error: "username, name, password, role are required" }, { status: 400 });
  }
  if (!["salesman", "manager", "warehouse", "admin"].includes(role)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }
  if (role === "admin" && caller.role !== "admin") {
    return NextResponse.json({ error: "Only an Admin can grant Admin access." }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const email = `${username}@fgtbilling.internal`;
  const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authErr || !authUser.user) {
    return NextResponse.json({ error: authErr?.message ?? "Failed to create account" }, { status: 400 });
  }

  const { data: row, error: rowErr } = await admin
    .from("users")
    .insert({
      auth_user_id: authUser.user.id,
      username,
      full_name: name,
      role,
      is_active: true,
      email,
    })
    .select("id, username, full_name, role, is_active")
    .single();

  if (rowErr) {
    await admin.auth.admin.deleteUser(authUser.user.id);
    return NextResponse.json({ error: rowErr.message }, { status: 400 });
  }

  return NextResponse.json({ user: row });
}
