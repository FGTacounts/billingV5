import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// The uploaded logo always lives at this one fixed path in the public
// "brand-assets" bucket (upsert on every upload) — so every consumer
// (Sidebar nav, invoice PDFs) can reference the same deterministic URL with
// no app_settings column needed. Content-Type is set from the real upload,
// not the ".png" in the key, so any image format works.
const LOGO_PATH = "logo.png";
// PNG/JPEG only — pdf-lib (used for invoice PDFs) can only embed these two
// formats, and the logo needs to render correctly everywhere it's used, not
// just in the web sidebar.
const ALLOWED_TYPES = ["image/png", "image/jpeg"];
const MAX_BYTES = 5 * 1024 * 1024;

function requireManager(user: Awaited<ReturnType<typeof getAppUser>>) {
  return user && (user.role === "manager" || user.role === "admin");
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!requireManager(user)) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: "Logo must be PNG or JPEG" }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "Logo must be under 5MB" }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error } = await admin.storage.from("brand-assets").upload(LOGO_PATH, bytes, {
    contentType: file.type,
    upsert: true,
  });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data } = admin.storage.from("brand-assets").getPublicUrl(LOGO_PATH);
  return NextResponse.json({ url: data.publicUrl });
}

export async function DELETE() {
  const user = await getAppUser();
  if (!requireManager(user)) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }
  await admin.storage.from("brand-assets").remove([LOGO_PATH]);
  return NextResponse.json({ ok: true });
}
