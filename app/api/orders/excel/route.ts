import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { fetchOrder, fetchOrderItems } from "@/lib/queries/orders";
import { parseLineSort } from "@/lib/lineSort";
import { computeInvoiceLines, invoiceTotals } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";
import { toAed, toFils } from "@/lib/money";
import { orderVatRate } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Row-level Excel export for a single order (Order Flow & Additions §2) —
// same NO/SKU/DESCRIPTION/UOS/QTY/PRICE/DISCOUNT/NET PRICE/SUBTOTAL/VAT/NET
// TOTAL columns and the same per-line arithmetic as the PDF invoice
// (computeInvoiceLines is shared so the two can never drift apart), as a
// real spreadsheet rather than a rendered document.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();
  const order = await fetchOrder(supabase, orderId);
  if (!order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });

  // The rate the order is billed at — its own (Additional changes), else its
  // customer's zone, else the app-wide one — as approval stores it.
  const [items, vatRate] = await Promise.all([
    fetchOrderItems(supabase, orderId),
    orderVatRate(supabase, order.id, order.customer_id ?? null),
  ]);
  const lines = computeInvoiceLines(items, vatRate, parseLineSort(req.nextUrl.searchParams.get("sort")));

  // Unpicked lines are always at the end (owner, 2026-09-26), which replaced
  // the manager's "Sheet View: separate marked/unmarked" setting.

  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(t("orders.excelSheetName"));
  sheet.columns = [
    { header: t("orders.columnNo"), key: "no", width: 6 },
    { header: t("orders.columnSku"), key: "sku", width: 14 },
    { header: t("orders.columnDescription"), key: "desc", width: 34 },
    { header: t("orders.columnUos"), key: "uos", width: 10 },
    { header: t("orders.columnQty"), key: "qty", width: 8 },
    { header: t("orders.columnPrice"), key: "price", width: 10 },
    { header: t("orders.columnDiscount"), key: "discount", width: 10 },
    { header: t("orders.columnNetPrice"), key: "netPrice", width: 12 },
    { header: t("orders.columnVat"), key: "vat", width: 10 },
    { header: t("orders.columnNetTotal"), key: "netTotal", width: 12 },
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
      vat: l.vat,
      netTotal: l.netTotal,
    });
  }
  // The same footer as the PDF (invoiceTotals): VAT once on the net
  // subtotal, so the grand total is the order's stored total.
  const totals = invoiceTotals(lines, order, vatRate);
  const orderDiscountFils = toFils(order.discount_amount ?? 0);
  const { netSubtotal, vatTotal, grandTotal } = totals;
  sheet.addRow({});
  if (orderDiscountFils > 0) sheet.addRow({ desc: t("orders.orderDiscount"), netTotal: -toAed(orderDiscountFils) });
  sheet.addRow({ desc: t("orders.subtotalWithoutVat"), netTotal: netSubtotal });
  sheet.addRow({ desc: t("orders.vatTotal"), netTotal: vatTotal });
  const totalRow = sheet.addRow({ desc: t("orders.grandTotal"), netTotal: grandTotal });
  totalRow.font = { bold: true };

  const buffer = await wb.xlsx.writeBuffer();
  const fileName = `${invoiceFileBase(order.invoice_number, order.billed_at ?? order.updated_at ?? order.created_at)}.xlsx`;
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
