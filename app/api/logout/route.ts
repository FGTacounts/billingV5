import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";
import { ACT_AS_COOKIE } from "@/lib/auth";

export async function POST() {
  const supabase = supabaseServer();
  await supabase.auth.signOut();
  // The door an admin came in by ends with the session (lib/auth.ts).
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(ACT_AS_COOKIE);
  return res;
}
