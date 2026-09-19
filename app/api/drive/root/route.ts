import { NextResponse } from "next/server";
import { productPhotosFolderId } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Where the product photo library starts.
//
// The phone hard-codes this folder id in DriveClient (`rootFolderID`, shown
// as "Products"); the browser must not, so it asks for it here and the
// server answers from app_settings.product_photos_drive_folder_id — the same
// setting /api/product-photo and the upload routes already read. Everything
// below this point is reached with /api/drive/list and /api/drive/search,
// which take a folder id the caller was already given.
export async function GET() {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  try {
    return NextResponse.json(
      { folderId: await productPhotosFolderId(), name: "Products" },
      { headers: { "Cache-Control": "private, max-age=300" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
