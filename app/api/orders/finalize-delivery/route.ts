import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrder, fetchOrderItems } from "@/lib/queries/orders";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import {
  uploadToDrive,
  privateUploadsFolderId,
  invoiceProofFolderId,
  deliveryProofName,
} from "@/lib/google-drive";

export const runtime = "nodejs";

// Confirms delivery: uploads the delivery-proof photo and auto-generates the
// finalized Tax Invoice PDF to Drive as a recordkeeping copy (§6). Neither
// URL has a column to persist to in this schema revision (see plan/README —
// invoice_pdf_url/delivery_proof_url were dropped), so the PDF stays
// generate-on-demand via /api/invoice-pdf; this route still uploads both to
// Drive for the paper trail, it just can't link back to them from the order
// row. All server-side so Drive credentials never reach the client.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "warehouse" && (user.role !== "manager" && user.role !== "admin"))) {
    return NextResponse.json({ error: "Warehouse or Manager access required" }, { status: 403 });
  }

  const form = await req.formData();
  const orderId = form.get("orderId");
  // More than one photo is normal: a pallet, a signature, a shop front. The
  // single-photo field is still accepted so nothing that already posts one
  // has to change.
  const photos = [...form.getAll("photos"), ...form.getAll("photo")].filter(
    (p): p is File => p instanceof File && p.size > 0
  );
  if (typeof orderId !== "string") {
    return NextResponse.json({ error: "orderId is required" }, { status: 400 });
  }

  const supabase = supabaseServer();
  const order = await fetchOrder(supabase, orderId);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const proofUrls: string[] = [];
  let invoicePdfUrl: string | null = null;

  try {
    // Proof goes to its own folder so it can be found again by name; the
    // invoice PDF stays with the other private uploads.
    const [proofFolder, folderId] = await Promise.all([
      invoiceProofFolderId(),
      privateUploadsFolderId(),
    ]);

    const now = new Date();
    for (const [index, photo] of photos.entries()) {
      const bytes = Buffer.from(await photo.arrayBuffer());
      // INV4300_30AUG26 — the invoice number in the file name is what lets the
      // Invoices screen find this again, since no column records it.
      const name = deliveryProofName(order.invoice_number ?? null, order.id, now, index);
      const uploaded = await uploadToDrive(
        proofFolder,
        `${name}.jpg`,
        bytes,
        photo.type || "image/jpeg"
      );
      proofUrls.push(uploaded.webViewLink);
    }

    const [items, settings] = await Promise.all([
      fetchOrderItems(supabase, orderId),
      supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle(),
    ]);
    const pdfBytes = await buildInvoicePdf(order, items, "tax", settings.data?.vat_rate);
    const uploaded = await uploadToDrive(
      folderId,
      `tax-invoice-${order.invoice_number ?? order.id}.pdf`,
      Buffer.from(pdfBytes),
      "application/pdf"
    );
    invoicePdfUrl = uploaded.webViewLink;
  } catch (e) {
    // Drive isn't configured in every environment (e.g. local dev without
    // service-account env vars) — still confirm delivery rather than
    // blocking the whole operation.
    console.error("Drive upload failed during delivery finalization:", e);
  }

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("orders")
    .update({ status: "delivered" })
    .eq("id", orderId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await supabase
    .from("order_status_log")
    .insert({ order_id: orderId, changed_by: user.id, changed_at: nowIso });

  return NextResponse.json({ ok: true, proofUrls, invoicePdfUrl });
}
