import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Self-only email/phone editing (Order Flow & Additions §6: "Account —
// change password; add or edit email and phone number... both update the
// users table automatically, no separate sync step"). Password itself is
// changed client-side via supabase.auth.updateUser, which needs no server
// route. Service-role so a missing `phone` column (pre-migration) fails
// here as a clean error instead of an RLS-shaped 403.
export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const admin = supabaseAdmin();
  const { data, error } = await admin.from("users").select("email, phone").eq("id", user.id).maybeSingle();
  if (error) return NextResponse.json({ email: user.email ?? "", phone: "" });
  return NextResponse.json({ email: data?.email ?? "", phone: data?.phone ?? "" });
}

export async function PATCH(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { email, phone } = (await req.json()) as { email?: string | null; phone?: string | null };
  const patch: Record<string, string | null> = {};
  if (email !== undefined) patch.email = email;
  if (phone !== undefined) patch.phone = phone;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { error } = await admin.from("users").update(patch).eq("id", user.id);
  if (error) {
    if (patch.phone !== undefined && error.message.includes("phone")) {
      return NextResponse.json(
        { error: "Phone number isn't set up yet — run the pending database migration first." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
