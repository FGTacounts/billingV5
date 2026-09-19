import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { buildSalesmanStatement } from "@/lib/statement";
import { buildSalesmanStatementPdf } from "@/lib/pdf/salesman-statement";
import { InvoiceTemplate } from "@/lib/invoice-template";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Salesman-wise statement: what is still owed on the orders one salesman took.
//
//   ?salesmanId=<users.id>            JSON, for the Reports tab and the phone
//   &format=pdf                       the printable statement
//   &format=excel                     manager/admin only, as every Excel export is
//
// A manager or admin may open anyone's. A salesman may open their OWN and
// nobody else's — what a colleague is owed is that colleague's customers'
// business. The warehouse has no use for it and is refused. The reads run as
// the caller (supabaseCaller), so row security applies as it does in the app.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.notSignedIn") }, { status: 401 });

  const isManager = user.role === "manager" || user.role === "admin";
  const salesmanId = req.nextUrl.searchParams.get("salesmanId") || (user.role === "salesman" ? user.id : "");
  if (!salesmanId) return NextResponse.json({ error: t("reports.ssSalesmanRequired") }, { status: 400 });
  if (!isManager && !(user.role === "salesman" && salesmanId === user.id)) {
    return NextResponse.json({ error: t("reports.ssOwnOnly") }, { status: 403 });
  }

  const supabase = supabaseCaller();
  const { data: salesman } = await supabase.from("users").select("id, full_name, username").eq("id", salesmanId).maybeSingle();
  const salesmanName = salesman?.full_name || salesman?.username || t("common.notSet");

  const statement = await buildSalesmanStatement(supabase, salesmanId);
  const format = req.nextUrl.searchParams.get("format");
  if (format !== "pdf" && format !== "excel") {
    return NextResponse.json({ salesman: { id: salesmanId, name: salesmanName }, ...statement });
  }

  const statementDate = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const safeName = salesmanName.replace(/[^\w&.() -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  const fileBase = `Salesman statement ${safeName} ${new Date().toLocaleDateString("en-GB").replace(/\//g, ".")}`;

  if (format === "excel") {
    if (!isManager) return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet(safeName.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Statement");
    sheet.addRow([InvoiceTemplate.companyName]).font = { bold: true, size: 14 };
    sheet.addRow([t("reports.ssTitle")]).font = { bold: true, size: 12 };
    sheet.addRow([`${t("reports.ssSalesman")} ${salesmanName}`]).font = { bold: true };
    sheet.addRow([`${t("customers.stmtStatementDate")}: ${statementDate}`]);
    sheet.addRow([]);
    const head = sheet.addRow([
      t("customers.stmtColDate"),
      t("customers.stmtColInvNo"),
      t("reports.ssColCustomer"),
      "CODE",
      t("customers.stmtColTotalPayable"),
      t("customers.stmtColReceived"),
      t("customers.stmtColBalance"),
      t("customers.stmtColDays"),
      t("reports.ssOverduePill").toUpperCase(),
    ]);
    head.font = { bold: true };
    head.eachCell((c) => (c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEBEBEB" } }));
    for (const r of statement.rows) {
      sheet.addRow([
        new Date(r.date).toLocaleDateString("en-GB"),
        r.invNo,
        r.customerName,
        r.customerCode,
        r.totalPayable,
        r.received,
        r.balance,
        r.days,
        r.overdue ? "YES" : "",
      ]);
    }
    const total = sheet.addRow([
      t("customers.stmtTotals"), "", "", "",
      statement.totals.totalPayable, statement.totals.received, statement.totals.balance, "", "",
    ]);
    total.font = { bold: true };
    for (const col of [5, 6, 7]) sheet.getColumn(col).numFmt = "#,##0.00";
    sheet.columns.forEach((c, i) => (c.width = i === 2 ? 38 : 16));
    const buffer = await wb.xlsx.writeBuffer();
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileBase}.xlsx"`,
      },
    });
  }

  const bytes = await buildSalesmanStatementPdf(salesmanName, statement, statementDate);
  return new NextResponse(Buffer.from(bytes), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${fileBase}.pdf"` },
  });
}
