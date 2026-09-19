import { NextRequest, NextResponse } from "next/server";
import { searchDrive } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ error: t("products.queryRequired") }, { status: 400 });

  try {
    return NextResponse.json(await searchDrive(q, req.nextUrl.searchParams.get("pageToken")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
