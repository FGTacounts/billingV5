import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchExpenseSummaryServer } from "@/lib/expenses-summary-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The summary card on Expenses: this month against last, by type, and the
// biggest entries. Manager and admin only, as every expense read is.
//
// The caller says which month it is (`month=YYYY-MM`), because "this month"
// is the month where the person is sitting: this server runs in UTC, and
// working it out here would still be showing September for the first four
// hours of October in the UAE.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const match = /^(\d{4})-(\d{2})$/.exec(req.nextUrl.searchParams.get("month") ?? "");
  const year = match ? Number(match[1]) : NaN;
  const month = match ? Number(match[2]) : NaN;
  if (!match || month < 1 || month > 12) {
    return NextResponse.json({ error: t("expense.summaryFailed") }, { status: 400 });
  }

  try {
    const summary = await fetchExpenseSummaryServer(supabaseAdmin(), { year, month });
    return NextResponse.json({ summary });
  } catch {
    return NextResponse.json({ error: t("expense.summaryFailed") }, { status: 500 });
  }
}
