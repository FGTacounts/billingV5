import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Your own photo, in the corner where your initials are.
//
// The same "avatars" bucket and the same one-object-per-user key the phone
// already writes (AccountSheet.swift: `user_<id>.jpg`, upsert), so a photo
// set on either app is the photo on both. `user.id` is the `users` row id on
// both sides — the same id /api/account writes email and phone against.
//
// The extension is part of the key, not a claim about the bytes: like the
// brand logo's fixed `logo.png`, it makes the URL predictable for every
// reader (the phone builds it without asking anyone) while Content-Type is
// set from the real upload.
const avatarPath = (userId: string) => `user_${userId}.jpg`;
const BUCKET = "avatars";

// PNG and JPEG only, as for the brand logo. Everything that reads an avatar
// is an <img> or an AsyncImage, both of which take either.
const ALLOWED_TYPES = ["image/png", "image/jpeg"];
const MAX_BYTES = 5 * 1024 * 1024;

// Uploaded through this route rather than from the browser (rule 4): the
// write needs a key the client must never hold, and the path is decided here
// from the signed-in caller — so a session can only ever replace its own
// photo, whatever path it asks for.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: t("common.fileRequired") }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: t("settings.photoMustBePngOrJpeg") }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: t("settings.photoMustBeUnder5Mb") }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const path = avatarPath(user.id);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const put = () =>
    admin.storage.from(BUCKET).upload(path, bytes, { contentType: file.type, upsert: true });

  let { error } = await put();

  // The phone tells people to go and make the bucket by hand when it isn't
  // there ("Check that the 'avatars' storage bucket exists in Supabase").
  // One public bucket is the whole prerequisite, so make it and try again
  // rather than sending someone to the dashboard. Public because both apps
  // read the photo straight from its URL, exactly as they do the logo.
  if (error && /bucket/i.test(error.message)) {
    const created = await admin.storage.createBucket(BUCKET, { public: true });
    if (!created.error) ({ error } = await put());
  }

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
