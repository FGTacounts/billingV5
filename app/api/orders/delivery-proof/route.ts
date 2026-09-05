import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { invoiceProofFolderId, findFilesByPrefix, deliveryProofPrefix } from "@/lib/google-drive";

export const runtime = "nodejs";

// Proof photos for one invoice.
//
// There is no column on the order recording what was uploaded, so the file
// name carries the link instead: proof is stored as INV4300_30AUG26 and found
// again by the INV4300_ prefix. That is why the naming format matters.
//
// Open to any signed-in user: everyone can already see the invoice, and the
// proof is a photo of its delivery.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const invoiceNumber = req.nextUrl.searchParams.get("invoiceNumber");
  if (!invoiceNumber) {
    return NextResponse.json({ error: "invoiceNumber is required" }, { status: 400 });
  }

  try {
    const folderId = await invoiceProofFolderId();
    const files = await findFilesByPrefix(folderId, deliveryProofPrefix(invoiceNumber));
    return NextResponse.json({ files });
  } catch {
    // Drive is not configured everywhere. An empty list reads as "no proof
    // yet", which is the honest answer when we cannot look.
    return NextResponse.json({ files: [] });
  }
}
