import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { uploadToDrive, privateUploadsFolderId } from "@/lib/google-drive";

export const runtime = "nodejs";

// Cheque photos go to the hidden private-uploads Drive folder (§7), never
// Supabase Storage. Returns a reference to store on payments.cheque_photo_ref.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const photo = form.get("photo") as File | null;
  if (!photo || photo.size === 0) {
    return NextResponse.json({ error: "photo is required" }, { status: 400 });
  }

  try {
    const folderId = await privateUploadsFolderId();
    const bytes = Buffer.from(await photo.arrayBuffer());
    const uploaded = await uploadToDrive(
      folderId,
      `cheque-${Date.now()}.jpg`,
      bytes,
      photo.type || "image/jpeg"
    );
    return NextResponse.json({ ref: uploaded.webViewLink });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Drive upload failed" },
      { status: 502 }
    );
  }
}
