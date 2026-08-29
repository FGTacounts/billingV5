import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { UserPreferences } from "@/lib/types/db";

export const runtime = "nodejs";

// Self-only preferences (theme, dashboard widget order, average-sale
// range) — §0.3/§1.2/§1.11 want these server-persisted per user, not just
// localStorage. Routed through the service-role key rather than the
// caller's own RLS session purely so a missing `users.preferences` column
// (pre-migration — see scratchpad/preferences-migration.sql) fails as a
// clean, catchable error here instead of surfacing as an RLS-shaped 403 the
// client can't distinguish from a real permission problem.
export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const admin = supabaseAdmin();
  const { data, error } = await admin.from("users").select("preferences").eq("id", user.id).maybeSingle();
  if (error) {
    // Most likely: the migration hasn't been run yet. Don't break the
    // caller over an optional feature — just report "no preferences yet."
    return NextResponse.json({ preferences: {}, migrated: false });
  }
  return NextResponse.json({ preferences: data?.preferences ?? {}, migrated: true });
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const patch = (await req.json()) as Partial<UserPreferences>;

  const admin = supabaseAdmin();
  const { data: existing, error: readErr } = await admin
    .from("users")
    .select("preferences")
    .eq("id", user.id)
    .maybeSingle();
  if (readErr) {
    return NextResponse.json(
      { error: "Preferences column not found — run the preferences migration first." },
      { status: 409 }
    );
  }

  const merged = { ...(existing?.preferences ?? {}), ...patch };
  const { error } = await admin.from("users").update({ preferences: merged }).eq("id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true, preferences: merged });
}
