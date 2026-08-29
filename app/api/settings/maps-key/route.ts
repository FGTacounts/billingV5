import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// The Google Maps key never round-trips to the client, even to the
// Manager/Admin who set it — GET only reports whether one exists, matching
// how the app already treats other secrets (§Next Updates Planning:
// "remains hidden for all users until the key is inputted").
export async function GET() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  try {
    const { data } = await supabaseAdmin()
      .from("app_settings")
      .select("google_maps_api_key")
      .limit(1)
      .maybeSingle();
    return NextResponse.json({ configured: !!data?.google_maps_api_key });
  } catch {
    return NextResponse.json({ configured: false });
  }
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  const { apiKey } = await req.json();
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    return NextResponse.json({ error: "apiKey is required" }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { data: settings } = await admin.from("app_settings").select("id").limit(1).maybeSingle();
  if (!settings) {
    return NextResponse.json({ error: "No app_settings row found" }, { status: 500 });
  }
  const { error } = await admin
    .from("app_settings")
    .update({ google_maps_api_key: apiKey.trim() })
    .eq("id", settings.id);
  if (error) {
    return NextResponse.json(
      { error: error.message || "Couldn't save the key — the google_maps_api_key column may not exist yet." },
      { status: 400 }
    );
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  const admin = supabaseAdmin();
  const { data: settings } = await admin.from("app_settings").select("id").limit(1).maybeSingle();
  if (settings) {
    await admin.from("app_settings").update({ google_maps_api_key: null }).eq("id", settings.id);
  }
  return NextResponse.json({ ok: true });
}
