import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { uploadToDrive, chequeFolderId, chequePhotoName } from "@/lib/google-drive";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// Cheque photos go to the hidden private-uploads Drive folder (§7), never
// Supabase Storage. Returns a reference to store on payments.cheque_photo_ref.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const photo = form.get("photo") as File | null;
  const customerId = form.get("customerId");
  if (!photo || photo.size === 0) {
    return NextResponse.json({ error: "photo is required" }, { status: 400 });
  }

  try {
    const supabase = supabaseServer();

    // Named for the customer and how many cheques they have had —
    // CUSTOMERNAME1, CUSTOMERNAME2 — so a cheque can be found in Drive by
    // the customer it came from rather than by upload time.
    let filename = `CHEQUE${Date.now()}`;
    if (typeof customerId === "string" && customerId) {
      const [{ data: customer }, { count }] = await Promise.all([
        supabase.from("customers").select("name").eq("id", customerId).maybeSingle(),
        supabase
          .from("payments")
          .select("id", { count: "exact", head: true })
          .eq("customer_id", customerId),
      ]);
      if (customer?.name) filename = chequePhotoName(customer.name, (count ?? 0) + 1);
    }

    const folderId = await chequeFolderId();
    const bytes = Buffer.from(await photo.arrayBuffer());
    const uploaded = await uploadToDrive(
      folderId,
      `${filename}.jpg`,
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
