import { NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every iPhone, iPad and Mac the app runs on, who last used it, and where it
// last was (owner, 2026-11-27: "i should be able to check where the device
// is … give the data only to the admin and not the manager"). The app keeps
// public.tracked_devices up to date through log_location_points (RUN-ME-48);
// this only reads it.
//
// Admins only — and an admin who signed in through the Salesman or Warehouse
// door is that role for the session (lib/auth.ts), so gets a 403 here too.
// RLS says admins only as well.
//
// Until RUN-ME-48 has been run the table is not there: `available: false`,
// and the page leaves the section out.

interface DeviceRow {
  device_id: string;
  user_id: string | null;
  platform: string | null;
  model: string | null;
  device_name: string | null;
  app_version: string | null;
  last_seen_at: string;
  last_fix_at: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  last_accuracy_m: number | null;
  users?: { full_name: string | null; role: string | null } | { full_name: string | null; role: string | null }[] | null;
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205" || error.code === "PGRST200") return true;
  return /tracked_devices/i.test(error.message ?? "") && /does not exist|schema cache/i.test(error.message ?? "");
}

export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: t("planning.devicesAdminOnly") }, { status: 403 });

  // A handful of devices — one read, no paging needed. Newest first.
  const { data, error } = await supabaseCaller()
    .from("tracked_devices")
    .select(
      "device_id, user_id, platform, model, device_name, app_version, last_seen_at, last_fix_at, last_latitude, last_longitude, last_accuracy_m, users(full_name, role)"
    )
    .order("last_seen_at", { ascending: false })
    .limit(500);

  if (error) {
    if (isMissingTable(error)) return NextResponse.json({ available: false, devices: [] });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  const devices = ((data ?? []) as DeviceRow[]).map((d) => {
    const person = Array.isArray(d.users) ? d.users[0] : d.users;
    return {
      deviceId: d.device_id,
      userId: d.user_id,
      userName: person?.full_name ?? null,
      userRole: person?.role ?? null,
      platform: d.platform,
      model: d.model,
      name: d.device_name,
      appVersion: d.app_version,
      lastSeenAt: d.last_seen_at,
      lastFixAt: d.last_fix_at,
      lat: d.last_latitude,
      lon: d.last_longitude,
      acc: d.last_accuracy_m,
    };
  });
  return NextResponse.json({ available: true, devices });
}
