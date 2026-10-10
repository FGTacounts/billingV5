import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchProductSummaryServer } from "@/lib/products-summary-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The summary card on Products: stock value and what sold in a window.
// Manager and admin only — the stock value is cost, and it is only ever sent
// as totals, never per article.
//
// The caller says where the month starts and ends (`from` / `to`, ISO
// instants), because "this month" is the month where the person is sitting:
// this server runs in UTC, and working it out here would start October four
// hours late for a browser in the UAE and disagree with Sales and Orders.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const from = new Date(req.nextUrl.searchParams.get("from") ?? "");
  const to = new Date(req.nextUrl.searchParams.get("to") ?? "");
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
    return NextResponse.json({ error: t("products.summaryFailed") }, { status: 400 });
  }

  try {
    const summary = await fetchProductSummaryServer(supabaseAdmin(), {
      from: from.toISOString(),
      to: to.toISOString(),
    });
    return NextResponse.json({ summary });
  } catch {
    return NextResponse.json({ error: t("products.summaryFailed") }, { status: 500 });
  }
}
