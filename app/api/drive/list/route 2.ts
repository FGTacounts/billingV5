import { NextRequest, NextResponse } from "next/server";
import { listDriveFolder } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Folder listing for the iOS photo browser. The phone holds no Google
// credential; it calls this with its own Supabase token and the server does
// the Drive call. Any signed-in staff member may browse — the same access
// they had when the app talked to Drive directly.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const folderId = req.nextUrl.searchParams.get("folderId");
  if (!folderId) return NextResponse.json({ error: t("products.folderIdRequired") }, { status: 400 });

  try {
    const listing = await listDriveFolder(folderId, req.nextUrl.searchParams.get("pageToken"), {
      namePrefix: req.nextUrl.searchParams.get("namePrefix"),
      imagesOnly: req.nextUrl.searchParams.get("imagesOnly") === "1",
    });
    return NextResponse.json(listing, {
      headers: { "Cache-Control": "private, max-age=300" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
