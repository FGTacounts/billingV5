import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { uploadToDrive, productPhotosFolderId, invalidatePhotoCache } from "@/lib/google-drive";

export const runtime = "nodejs";

// Product photos live in the shared product-photos Drive folder and are
// matched back to a product by filename == SKU (see findProductPhoto), so
// the upload is named after the SKU rather than given a random name.
// Manager-only: this writes to a folder every user reads from.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const form = await req.formData();
  const photo = form.get("photo") as File | null;
  const sku = String(form.get("sku") ?? "").trim();
  if (!photo || photo.size === 0) {
    return NextResponse.json({ error: "photo is required" }, { status: 400 });
  }
  if (!sku) {
    return NextResponse.json({ error: "sku is required" }, { status: 400 });
  }

  const ext = (photo.type.split("/")[1] || "jpg").replace("jpeg", "jpg");

  try {
    const folderId = await productPhotosFolderId();
    const bytes = Buffer.from(await photo.arrayBuffer());
    await uploadToDrive(folderId, `${sku}.${ext}`, bytes, photo.type || "image/jpeg");
    // The SKU→file map is cached for 5 minutes; without this the new photo
    // wouldn't show until that expired.
    invalidatePhotoCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Drive upload failed" },
      { status: 502 }
    );
  }
}
