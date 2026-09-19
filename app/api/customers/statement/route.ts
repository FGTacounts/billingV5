import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { buildStatement, type StatementScope } from "@/lib/statement";
import { buildStatementPdf } from "@/lib/pdf/statement";
import { InvoiceTemplate } from "@/lib/invoice-template";
import { FALLBACK_VAT_RATE } from "@/lib/money";
import { t } from "@/lib/i18n";

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
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const customerId = req.nextUrl.searchParams.get("customerId");
  const group = req.nextUrl.searchParams.get("group")?.trim();
  if (!customerId && !group) {
    return NextResponse.json({ error: t("customers.customerIdOrGroupRequired") }, { status: 400 });
  }
  const requestedFormat = req.nextUrl.searchParams.get("format");
  const isManager = user.role === "manager" || user.role === "admin";

  // A group statement spans every shop trading under one account, so it
  // discloses the other branches' trading to whoever holds it. Manager and
  // Admin only — a salesman still statements the single shop they are on.
  if (group && !isManager) {
    return NextResponse.json(
      { error: t("customers.groupStatementManagerOnly") },
      { status: 403 }
    );
  }

  const supabase = supabaseCaller();

  // The shops the statement covers, and the header it is issued under.
  let customer: { id: string; code: string; name: string; district: string | null; address: string | null; vat_number: string | null } | null = null;
  let statementIds: string[] = [];
  let groupShopCount = 0;

  if (group) {
    const { data: members } = await supabase
      .from("customers")
      .select("id, code, name, district, address, vat_number")
      .eq("group_name", group)
      .order("code");
    const rows = members ?? [];
    if (rows.length === 0) {
      return NextResponse.json({ error: t("customers.noShopsInGroup") }, { status: 404 });
    }
    statementIds = rows.map((r) => r.id);
    groupShopCount = rows.length;
    // Issued to the group, using the first shop's registration details —
    // they are one legal customer, which is the point of grouping them.
    customer = { ...rows[0], name: group };
  } else {
    const { data } = await supabase
      .from("customers")
      .select("id, code, name, district, address, vat_number")
      .eq("id", customerId!)
      .maybeSingle();
    if (!data) return NextResponse.json({ error: t("customers.customerNotFound") }, { status: 404 });
    customer = data;
    statementIds = [data.id];
  }

  const { data: settings } = await supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle();
  const vatRate = settings?.vat_rate ?? FALLBACK_VAT_RATE;
  // The statement people are sent is what they still owe. `scope=paid` is the
  // settled invoices (the button beside the Paid row); `scope=all` is the old
  // everything-in-date-order ledger, still answered for anyone who wants it.
  const scopeParam = req.nextUrl.searchParams.get("scope");
  const scope: StatementScope = scopeParam === "paid" || scopeParam === "all" ? scopeParam : "outstanding";
  const statement = await buildStatement(supabase, statementIds, vatRate, scope);
  const statementDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  // Named after the customer, the way the owner's own statement sheets are
  // ("M&SAVE_31.08.2026") — a folder of "Statement-20001" files says nothing
  // about whose they are. Characters a file system or a header cannot carry
  // are dropped; the code keeps two shops with one name apart.
  const safeName = (group ?? customer.name).replace(/[^\w&.() -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const day = new Date().toLocaleDateString("en-GB").replace(/\//g, ".");
  const kind = scope === "paid" ? "Paid statement" : "Statement";
  const fileBase = group ? `${kind} ${safeName} ${day}` : `${kind} ${safeName} (${customer.code}) ${day}`;

  // Excel is Manager-only (same financial-export restriction as everywhere
  // else) — a non-Manager's format param is ignored and falls through to PDF.
  const wantsExcel = isManager && requestedFormat !== "pdf";

  if (wantsExcel) {
    const buffer = await buildStatementExcel(customer, statement, statementDate, groupShopCount, scope);
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileBase}.xlsx"`,
      },
    });
  }

  const bytes = await buildStatementPdf(customer, statement, statementDate, groupShopCount, scope);
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
  statementDate: string,
  /// >0 when this covers a shop group rather than one shop.
  groupShopCount = 0,
  scope: StatementScope = "outstanding"
) {
  const wb = new ExcelJS.Workbook();
  // The tab carries the customer's name and the date, as the owner's own
  // sheets do. Excel allows 31 characters and none of \ / ? * [ ] :
  const tab = `${customer.name.replace(/[\\/?*[\]:]/g, " ").trim().slice(0, 20)}_${new Date()
    .toLocaleDateString("en-GB")
    .replace(/\//g, ".")}`;
  const sheet = wb.addWorksheet(tab || t("customers.statement"));

  sheet.addRow([InvoiceTemplate.companyName]);
  sheet.getCell("A1").font = { bold: true, size: 14 };
  sheet.addRow([]);
  sheet.addRow(["", "", "", InvoiceTemplate.companyName, "", t("customers.statementDateLabel"), "", statementDate]);
  sheet.addRow(["", "", "", "Dubai UAE"]);
  sheet.addRow(["", "", "", t("customers.statementTrn", { trn: InvoiceTemplate.trn })]);
  sheet.addRow(["", "", "", InvoiceTemplate.email]);
  sheet.addRow([]);
  sheet.addRow([scope === "paid" ? t("customers.statementOfAccountPaid") : t("customers.statementOfAccount")]);
  sheet.getCell(`A${sheet.rowCount}`).font = { bold: true, size: 13 };
  sheet.addRow([customer.name.toUpperCase()]);
  sheet.getCell(`A${sheet.rowCount}`).font = { bold: true };
  // Whoever receives this has to be able to tell at a glance that it is the
  // combined account and not one branch's.
  if (groupShopCount > 0) {
    sheet.addRow([t("customers.combinedAccountUpper", { n: groupShopCount })]);
    sheet.getCell(`A${sheet.rowCount}`).font = { bold: true, size: 10 };
  }
  if (customer.district || customer.address) {
    sheet.addRow([[customer.district, customer.address].filter(Boolean).join(" — ").toUpperCase()]);
  }
  sheet.addRow([]);

  const headerRow = sheet.addRow([
    t("customers.stmtColDate"),
    t("customers.stmtColInvNo"),
    t("customers.stmtColDescription"),
    t("customers.stmtColInvoiceAmount"),
    t("customers.stmtColVat"),
    t("customers.stmtColTotalPayable"),
    t("customers.stmtColReceived"),
    t("customers.stmtColBalance"),
    t("customers.stmtColDays"),
  ]);
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
    t("customers.stmtTotal"),
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
  sheet.addRow([t("customers.amountDue", { amount: statement.totals.balance.toLocaleString(undefined, { minimumFractionDigits: 2 }) })]).font = { bold: true };
  sheet.addRow([t("customers.paymentTerms", { terms: InvoiceTemplate.paymentTerms })]);
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
