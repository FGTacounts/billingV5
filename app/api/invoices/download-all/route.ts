import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrders, fetchOrderItems } from "@/lib/queries/orders";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";

export const runtime = "nodejs";

// Manager-only bulk export (§1.9 "Per-row Download, 'Download All' bulk") —
// generates every delivered order's Tax Invoice PDF server-side and zips
// them into one download, same PDF builder as the per-row /api/invoice-pdf
// route so the two never drift apart.
const MAX_ORDERS = 200;

export async function GET() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const supabase = supabaseServer();
  const orders = await fetchOrders(supabase, { status: ["delivered"], limit: MAX_ORDERS });
  if (orders.length === 0) {
    return NextResponse.json({ error: "No delivered invoices to export" }, { status: 404 });
  }

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const zip = new JSZip();
  const usedNames = new Set<string>();

  for (const order of orders) {
    const items = await fetchOrderItems(supabase, order.id);
    const bytes = await buildInvoicePdf(order, items, "tax", settings?.vat_rate);
    const base = invoiceFileBase(order.invoice_number, order.updated_at ?? order.created_at);
    let name = `${base}.pdf`;
    while (usedNames.has(name)) name = `${base}-${order.id.slice(0, 6)}.pdf`;
    usedNames.add(name);
    zip.file(name, bytes);
  }

  const zipBytes = await zip.generateAsync({ type: "uint8array" });
  return new NextResponse(Buffer.from(zipBytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="tax-invoices-${new Date().toISOString().slice(0, 10)}.zip"`,
    },
  });
}
