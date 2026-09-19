import { NextRequest, NextResponse } from "next/server";
import { fetchDriveFileBytes } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Raw bytes for one Drive file, by id. Ids come from /api/drive/list or
// /api/drive/search, so this is a fetch of something the caller was already
// shown rather than a way to reach new material.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: t("common.idRequired") }, { status: 400 });

  try {
    const { bytes, contentType } = await fetchDriveFileBytes(id);
    return new NextResponse(bytes, {
      headers: {
        "Content-Type": contentType,
        // Keyed by an immutable Drive file id, so it can be cached hard.
        "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
