import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Public, pre-login only — auth (§6/§10) accepts username OR the user's own
// contact email now, but Supabase Auth's actual identity is still the
// synthetic username@fgtbilling.internal address (§4). If the caller typed
// a real email, resolve it to the matching username here (service-role,
// since `users` requires an authenticated session to read directly) so
// LoginForm can build the same synthetic address it always has. Always
// returns { username: string | null } uniformly — never reveals whether
// the email itself exists, only enough for the client to proceed.
export async function POST(req: NextRequest) {
  const { identifier } = (await req.json()) as { identifier?: string };
  if (!identifier || !identifier.includes("@")) {
    return NextResponse.json({ username: null });
  }
  if (identifier.toLowerCase().endsWith("@fgtbilling.internal")) {
    return NextResponse.json({ username: null });
  }

  const admin = supabaseAdmin();
  const { data } = await admin
    .from("users")
    .select("username")
    .ilike("email", identifier.trim())
    .eq("is_active", true)
    .maybeSingle();

  return NextResponse.json({ username: data?.username ?? null });
}
