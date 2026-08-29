import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { buildStatement } from "@/lib/statement";
import { InvoiceTemplate } from "@/lib/invoice-template";
import { FALLBACK_VAT_RATE } from "@/lib/money";

export const runtime = "nodejs";

const AED = (n: number) => n.toFixed(2);

// Statement of Account (Order Flow & Additions §2/§12 — matches the
// attached FGT_Statement_of_Account.xlsx). Defaults to Excel for Manager,
// PDF for Salesman/Warehouse (the same everyone-gets-PDF-except-Manager
// rule established for every other export in this app), but a Manager can
// force either with ?format=pdf|excel (§Customers: "when a customer is
// opened, show both Excel and PDF download options").
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const customerId = req.nextUrl.searchParams.get("customerId");
  if (!customerId) return NextResponse.json({ error: "customerId is required" }, { status: 400 });
  const requestedFormat = req.nextUrl.searchParams.get("format");

  const supabase = supabaseServer();
  const { data: customer } = await supabase
    .from("customers")
    .select("id, code, name, district, address, vat_number")
    .eq("id", customerId)
    .maybeSingle();
  if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const vatRate = settings?.vat_rate ?? FALLBACK_VAT_RATE;
  const statement = await buildStatement(supabase, customerId, vatRate);
  const statementDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fileBase = `Statement-${customer.code}-${new Date().toISOString().slice(0, 10)}`;

  const isManager = user.role === "manager" || user.role === "admin";
  // Excel is Manager-only (same financial-export restriction as everywhere
  // else) — a non-Manager's format param is ignored and falls through to PDF.
  const wantsExcel = isManager && requestedFormat !== "pdf";

  if (wantsExcel) {
    const buffer = await buildStatementExcel(customer, statement, statementDate);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileBase}.xlsx"`,
      },
    });
  }

  const bytes = await buildStatementPdf(customer, statement, statementDate);
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileBase}.pdf"`,
    },
  });
}

async function buildStatementExcel(
  customer: { code: string; name: string; district: string | null; address: string | null; vat_number: string | null },
  statement: Awaited<ReturnType<typeof buildStatement>>,
  statementDate: string
) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Statement");

  sheet.addRow([InvoiceTemplate.companyName]);
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.addRow([]);
  sheet.addRow(["", "", "", InvoiceTemplate.companyName, "", "Statement Date:", "", statementDate]);
  sheet.addRow(["", "", "", "Dubai UAE"]);
  sheet.addRow(["", "", "", `TRN:${InvoiceTemplate.trn}`]);
  sheet.addRow(["", "", "", InvoiceTemplate.email]);
  sheet.addRow([]);
  sheet.addRow(["STATEMENT OF ACCOUNT"]);
  sheet.getCell(`A${sheet.rowCount}`).font = { bold: true, size: 13 };
  sheet.addRow([customer.name.toUpperCase()]);
  sheet.getCell(`A${sheet.rowCount}`).font = { bold: true };
  if (customer.district || customer.address) {
    sheet.addRow([[customer.district, customer.address].filter(Boolean).join(" — ").toUpperCase()]);
  }
  sheet.addRow([]);

  const headerRow = sheet.addRow(["DATE", "INV NO", "DESCRIPTION", "INVOICE AMOUNT", "VAT", "TOTAL PAYABLE", "RECEIVED", "BALANCE", "DAYS"]);
  headerRow.font = { bold: true };
  headerRow.eachCell((cell) => (cell.border = { bottom: { style: "thin" } }));

  for (const r of statement.rows) {
    sheet.addRow([
      new Date(r.date),
      r.invNo,
      r.description,
      r.invoiceAmount,
      r.vat,
      r.totalPayable,
      r.received || null,
      r.balance,
      r.days,
    ]);
  }

  const totalRow = sheet.addRow([
    "TOTAL",
    "",
    "",
    statement.totals.invoiceAmount,
    statement.totals.vat,
    statement.totals.totalPayable,
    statement.totals.received,
    statement.totals.balance,
  ]);
  totalRow.font = { bold: true };
  sheet.addRow([]);
  sheet.addRow([`AMOUNT DUE: ${statement.totals.balance.toLocaleString(undefined, { minimumFractionDigits: 2 })} AED`]).font = { bold: true };
  sheet.addRow([`PAYMENT TERMS: ${InvoiceTemplate.paymentTerms}`]);
  sheet.addRow([InvoiceTemplate.bankLine1]);
  sheet.addRow([InvoiceTemplate.bankLine2]);

  sheet.getColumn(1).width = 14;
  sheet.getColumn(2).width = 10;
  sheet.getColumn(3).width = 14;
  sheet.getColumn(4).width = 15;
  sheet.getColumn(5).width = 12;
  sheet.getColumn(6).width = 15;
  sheet.getColumn(7).width = 12;
  sheet.getColumn(8).width = 14;
  sheet.getColumn(9).width = 8;

  return wb.xlsx.writeBuffer();
}

async function buildStatementPdf(
  customer: { code: string; name: string; district: string | null },
  statement: Awaited<ReturnType<typeof buildStatement>>,
  statementDate: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const margin = 36;
  const ink = rgb(0.1, 0.12, 0.11);
  const muted = rgb(0.42, 0.46, 0.44);
  let y = 800;

  page.drawText(InvoiceTemplate.companyName, { x: margin, y, size: 14, font: bold, color: ink });
  y -= 16;
  page.drawText(`Statement Date: ${statementDate}`, { x: margin, y, size: 9, color: muted, font });
  y -= 24;
  page.drawText("STATEMENT OF ACCOUNT", { x: margin, y, size: 13, font: bold, color: ink });
  y -= 16;
  page.drawText(`${customer.name} (${customer.code})`, { x: margin, y, size: 10, font: bold, color: ink });
  y -= 12;
  if (customer.district) {
    page.drawText(customer.district, { x: margin, y, size: 9, font, color: muted });
    y -= 12;
  }

  y -= 12;
  const cols = { date: margin, inv: margin + 65, desc: margin + 115, amt: margin + 200, vat: margin + 270, payable: margin + 330, recv: margin + 400, bal: margin + 460, days: margin + 500 };
  page.drawText("DATE", { x: cols.date, y, size: 8, font: bold });
  page.drawText("INV NO", { x: cols.inv, y, size: 8, font: bold });
  page.drawText("DESC", { x: cols.desc, y, size: 8, font: bold });
  page.drawText("AMOUNT", { x: cols.amt, y, size: 8, font: bold });
  page.drawText("VAT", { x: cols.vat, y, size: 8, font: bold });
  page.drawText("PAYABLE", { x: cols.payable, y, size: 8, font: bold });
  page.drawText("RECEIVED", { x: cols.recv, y, size: 8, font: bold });
  page.drawText("BALANCE", { x: cols.bal, y, size: 8, font: bold });
  page.drawText("DAYS", { x: cols.days, y, size: 8, font: bold });
  y -= 6;
  page.drawLine({ start: { x: margin, y }, end: { x: 555, y }, thickness: 0.5, color: muted });
  y -= 12;

  for (const r of statement.rows) {
    if (y < 100) break;
    page.drawText(new Date(r.date).toLocaleDateString("en-GB"), { x: cols.date, y, size: 8, font });
    page.drawText(r.invNo, { x: cols.inv, y, size: 8, font });
    page.drawText(r.description, { x: cols.desc, y, size: 8, font });
    page.drawText(AED(r.invoiceAmount), { x: cols.amt, y, size: 8, font });
    page.drawText(AED(r.vat), { x: cols.vat, y, size: 8, font });
    page.drawText(AED(r.totalPayable), { x: cols.payable, y, size: 8, font });
    page.drawText(r.received ? AED(r.received) : "", { x: cols.recv, y, size: 8, font });
    page.drawText(AED(r.balance), { x: cols.bal, y, size: 8, font });
    page.drawText(String(r.days), { x: cols.days, y, size: 8, font });
    y -= 14;
  }

  y -= 8;
  page.drawLine({ start: { x: margin, y }, end: { x: 555, y }, thickness: 0.5, color: muted });
  y -= 16;
  page.drawText(`AMOUNT DUE: ${AED(statement.totals.balance)} AED`, { x: margin, y, size: 11, font: bold, color: ink });
  y -= 16;
  page.drawText(`PAYMENT TERMS: ${InvoiceTemplate.paymentTerms}`, { x: margin, y, size: 8, font, color: muted });
  y -= 12;
  page.drawText(InvoiceTemplate.bankLine1, { x: margin, y, size: 8, font, color: muted });
  y -= 12;
  page.drawText(InvoiceTemplate.bankLine2, { x: margin, y, size: 8, font, color: muted });

  return doc.save();
}
