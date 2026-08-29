import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrder, fetchOrderItems } from "@/lib/queries/orders";
import { computeInvoiceLines } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";
import { FALLBACK_VAT_RATE } from "@/lib/money";

export const runtime = "nodejs";

// Row-level Excel export for a single order (Order Flow & Additions §2) —
// same NO/SKU/DESCRIPTION/UOS/QTY/PRICE/DISCOUNT/NET PRICE/SUBTOTAL/VAT/NET
// TOTAL columns and the same per-line arithmetic as the PDF invoice
// (computeInvoiceLines is shared so the two can never drift apart), as a
// real spreadsheet rather than a rendered document.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();
  const order = await fetchOrder(supabase, orderId);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const [items, settings] = await Promise.all([
    fetchOrderItems(supabase, orderId),
    supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle(),
  ]);
  const vatRate = settings.data?.vat_rate ?? FALLBACK_VAT_RATE;
  let lines = computeInvoiceLines(items, vatRate);

  // Manager's Sheet View preference (§6/§7): default is plain article order
  // (already how `lines` comes out); when set, separate picked items from
  // unpicked ones instead — a stable partition, not a re-sort within each
  // group, so article order is preserved inside each half.
  if ((user.role === "manager" || user.role === "admin")) {
    const { data: prefRow } = await supabase.from("users").select("preferences").eq("id", user.id).maybeSingle();
    if (prefRow?.preferences?.downloadSeparateMarked) {
      const marked = items.map((it) => it.picked_qty != null && it.picked_qty > 0);
      lines = [...lines.filter((_, i) => marked[i]), ...lines.filter((_, i) => !marked[i])];
    }
  }

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Invoice");
  sheet.columns = [
    { header: "NO.", key: "no", width: 6 },
    { header: "SKU", key: "sku", width: 14 },
    { header: "DESCRIPTION", key: "desc", width: 34 },
    { header: "UOS", key: "uos", width: 10 },
    { header: "QTY", key: "qty", width: 8 },
    { header: "PRICE", key: "price", width: 10 },
    { header: "DISCOUNT", key: "discount", width: 10 },
    { header: "NET PRICE", key: "netPrice", width: 12 },
    { header: "SUBTOTAL", key: "subtotal", width: 12 },
    { header: "VAT", key: "vat", width: 10 },
    { header: "NET TOTAL", key: "netTotal", width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const l of lines) {
    sheet.addRow({
      no: l.no,
      sku: l.sku,
      desc: l.desc,
      uos: l.uos,
      qty: l.qty,
      price: l.price,
      discount: l.discount,
      netPrice: l.netPrice,
      subtotal: l.lineSubtotal,
      vat: l.vat,
      netTotal: l.netTotal,
    });
  }
  const netSubtotal = lines.reduce((s, l) => s + l.netPrice, 0);
  const vatTotal = lines.reduce((s, l) => s + l.vat, 0);
  const grandTotal = lines.reduce((s, l) => s + l.netTotal, 0);
  sheet.addRow({});
  sheet.addRow({ desc: "Subtotal without VAT", netTotal: netSubtotal });
  sheet.addRow({ desc: "VAT Total", netTotal: vatTotal });
  const totalRow = sheet.addRow({ desc: "Grand Total", netTotal: grandTotal });
  totalRow.font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  const fileName = `${invoiceFileBase(order.invoice_number, order.updated_at ?? order.created_at)}.xlsx`;
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
