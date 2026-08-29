import { NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Clears the caller's own notifications (§Global: "should stay in the small
// popup section until cleared"). Routed through the service-role client
// because RLS on `notifications` only grants SELECT/UPDATE to a user's own
// rows, not DELETE — this still only ever touches the caller's own
// notifications, verified server-side via getAppUser(), not client-supplied.
export async function POST() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { error } = await supabaseAdmin().from("notifications").delete().eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
