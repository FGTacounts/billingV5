import { NextRequest, NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrders } from "@/lib/queries/orders";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProductsServer } from "@/lib/products-server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { InvoiceTemplate } from "@/lib/invoice-template";

export const runtime = "nodejs";

// List exports for Settings > Data "Download All" (Order Flow & Additions
// §6) for Salesman/Warehouse — Manager gets the existing Excel export
// (/api/export/excel) for the same three data types; this is the
// PDF counterpart everyone else gets, per the export rule already
// established across every other download in this app.
async function drawTable(title: string, columns: string[], rows: string[][]) {
  const doc = await PDFDocument.create();
  let page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 36;
  const ink = rgb(0.1, 0.12, 0.11);
  const muted = rgb(0.42, 0.46, 0.44);
  const colW = (595.28 - margin * 2) / columns.length;
  let y = 800;

  function header() {
    page.drawText(InvoiceTemplate.companyName, { x: margin, y, size: 12, font: bold, color: ink });
    y -= 20;
    page.drawText(title, { x: margin, y, size: 14, font: bold, color: ink });
    y -= 18;
    columns.forEach((c, i) => page.drawText(c, { x: margin + i * colW, y, size: 8, font: bold, color: ink }));
    y -= 5;
    page.drawLine({ start: { x: margin, y }, end: { x: 595.28 - margin, y }, thickness: 0.5, color: muted });
    y -= 14;
  }
  header();

  for (const row of rows) {
    if (y < 60) {
      page = doc.addPage([595.28, 841.89]);
      y = 800;
      header();
    }
    row.forEach((v, i) => page.drawText(v, { x: margin + i * colW, y, size: 8, font, color: ink }));
    y -= 14;
  }

  return doc.save();
}

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const type = req.nextUrl.searchParams.get("type") ?? "orders";
  const supabase = supabaseServer();

  let bytes: Uint8Array;
  if (type === "customers") {
    const customers = await fetchCustomers(supabase);
    bytes = await drawTable(
      "Customers",
      ["Code", "Name", "District", "Phone"],
      customers.map((c) => [c.code, c.name, c.district ?? "", c.phone ?? ""])
    );
  } else if (type === "products") {
    const products = await fetchProductsServer(supabaseAdmin(), { isManager: (user.role === "manager" || user.role === "admin"), activeOnly: false });
    bytes = await drawTable(
      "Products",
      ["SKU", "Name", "Price"],
      products.map((p) => [p.sku, p.name, p.price.toFixed(2)])
    );
  } else if (type === "orders") {
    const orders = await fetchOrders(supabase, {
      salesmanId: user.role === "salesman" ? user.id : undefined,
      limit: 500,
    });
    bytes = await drawTable(
      "Orders",
      ["Invoice #", "Date", "Customer", "Status", "Total"],
      orders.map((o) => [
        o.invoice_number ? String(o.invoice_number) : "",
        new Date(o.created_at).toLocaleDateString(),
        o.customer?.name ?? o.new_customer_note ?? "",
        o.status,
        o.total != null ? o.total.toFixed(2) : "",
      ])
    );
  } else {
    return NextResponse.json({ error: "Unknown export type" }, { status: 400 });
  }

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${type}.pdf"`,
    },
  });
}
