import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { fetchAllPages } from "@/lib/paging";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// The road one salesman's device drove between two instants — one day on the
// Planning page (owner, 2026-11-27: "the route path should be logged each
// day"). The phone writes public.location_points (RUN-ME-46); this only reads.
//
// A manager or admin may ask for anybody; a salesman only for themselves.
// RLS says the same thing — this check is here so the answer is a clear 403
// rather than an empty route that looks like a day nobody drove.
//
// `from` and `to` are ISO instants the browser works out from its own
// midnight, the same way the visit log does: the server has no idea what day
// it is where the manager is sitting.
//
// Until RUN-ME-46 has been run the table is not there: `available: false`,
// and the page leaves the section out.

const MAX_SPAN_MS = 2 * 24 * 60 * 60 * 1000;

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  return /location_points/i.test(error.message ?? "") && /does not exist|schema cache/i.test(error.message ?? "");
}

interface PointRow {
  recorded_at: string;
  latitude: number;
  longitude: number;
  accuracy_m: number | null;
}

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const params = req.nextUrl.searchParams;
  const salesmanId = params.get("salesmanId") ?? "";
  const from = Date.parse(params.get("from") ?? "");
  const to = Date.parse(params.get("to") ?? "");
  if (!salesmanId || Number.isNaN(from) || Number.isNaN(to) || to <= from || to - from > MAX_SPAN_MS) {
    return NextResponse.json({ error: t("planning.trackBadRequest") }, { status: 400 });
  }

  const isManager = user.role === "manager" || user.role === "admin";
  if (!isManager && salesmanId !== user.id) {
    return NextResponse.json({ error: t("planning.trackNotAllowed") }, { status: 403 });
  }

  const db = supabaseCaller();
  try {
    // (user_id, recorded_at) is the key, so recorded_at alone is a stable,
    // unique order inside one person's rows — what paging needs.
    const rows = await fetchAllPages<PointRow>((lo, hi) =>
      db
        .from("location_points")
        .select("recorded_at, latitude, longitude, accuracy_m")
        .eq("user_id", salesmanId)
        .gte("recorded_at", new Date(from).toISOString())
        .lt("recorded_at", new Date(to).toISOString())
        .order("recorded_at", { ascending: true })
        .range(lo, hi)
    );
    // Short keys: a busy day is a thousand of these.
    return NextResponse.json({
      available: true,
      points: rows.map((r) => ({ t: r.recorded_at, lat: r.latitude, lon: r.longitude, acc: r.accuracy_m })),
    });
  } catch (e) {
    const error = e as { code?: string; message?: string };
    if (isMissingTable(error)) return NextResponse.json({ available: false, points: [] });
    return NextResponse.json({ error: error.message ?? t("planning.trackCouldntLoad") }, { status: 400 });
  }
}
