import { NextRequest, NextResponse } from "next/server";
import { uploadToDrive } from "@/lib/google-drive";
import { getAppUser } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024;

// Product photo upload from the phone. Managers and admins only — the same
// people who can edit a product. Salesmen and warehouse read the library but
// do not add to it.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });
  if (user.role !== "manager" && user.role !== "admin") {
    return NextResponse.json({ error: t("products.onlyManagerCanAddPhotos") }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file");
  const folderId = String(form.get("folderId") ?? "").trim();
  const filename = String(form.get("filename") ?? "").trim();

  if (!(file instanceof File)) return NextResponse.json({ error: t("common.fileRequired") }, { status: 400 });
  if (!folderId) return NextResponse.json({ error: t("products.folderIdRequired") }, { status: 400 });
  if (!filename) return NextResponse.json({ error: t("products.filenameRequired") }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: t("products.imageTooLarge25mb") }, { status: 413 });
  }

  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const saved = await uploadToDrive(folderId, filename, bytes, file.type || "image/jpeg");
    return NextResponse.json(saved);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : t("products.driveError") },
      { status: 502 }
    );
  }
}
