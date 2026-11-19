import ExcelJS from "exceljs";
import type { GrvExportCustomer } from "@/lib/queries/grv";
import { invoiceDate } from "@/lib/invoice-template";
import { money } from "@/lib/money";
import { t } from "@/lib/i18n";

// The GRV spreadsheet (owner, 2026-11-19: "make the customer details as
// header, and then the GRV below") — the same layout as the order's Excel
// export: a block of who the customer is, then a table of what came back,
// one block per customer. Used by app/api/grv/excel.
export function buildGrvWorkbook(customers: GrvExportCustomer[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(t("grvExcel.sheetName"));
  const columns = [
    { header: t("grvExcel.columnGrv"), key: "grv", width: 10 },
    { header: t("grvExcel.columnDate"), key: "date", width: 12 },
    { header: t("grvExcel.columnStatus"), key: "status", width: 11 },
    { header: t("grvExcel.columnSku"), key: "sku", width: 14 },
    { header: t("grvExcel.columnDescription"), key: "desc", width: 36 },
    { header: t("grvExcel.columnQty"), key: "qty", width: 8 },
    { header: t("grvExcel.columnUnitValue"), key: "unit", width: 12 },
    { header: t("grvExcel.columnValue"), key: "value", width: 12 },
  ];
  sheet.columns = columns.map(({ key, width }) => ({ key, width }));
  const moneyFormat = "#,##0.00";

  customers.forEach((c, index) => {
    if (index > 0) {
      sheet.addRow([]);
      sheet.addRow([]);
    }
    const headerBlock: [string, string][] = [
      [t("grvExcel.customerName"), c.name || t("common.notSet")],
      [t("grvExcel.customerCode"), c.code || t("common.notSet")],
      [t("grvExcel.phone"), c.phone || t("common.notSet")],
      [t("grvExcel.address"), c.address || t("common.notSet")],
      [t("grvExcel.district"), c.district || t("common.notSet")],
      [t("grvExcel.trn"), c.vatNumber || t("common.notSet")],
      [t("grvExcel.salesman"), c.salesman || t("common.notSet")],
    ];
    for (const [label, value] of headerBlock) {
      const row = sheet.addRow([label, null, value]);
      sheet.mergeCells(row.number, 1, row.number, 2);
      row.getCell(1).font = { bold: true };
    }
    sheet.addRow([]);
    const headingRow = sheet.addRow(columns.map((col) => col.header));
    headingRow.font = { bold: true };

    let customerTotal = 0;
    for (const g of c.returns) {
      const base = { grv: g.label, date: invoiceDate(g.date), status: t(g.status === "approved" ? "grvExcel.approved" : "grvExcel.pending") };
      if (g.lines.length === 0) {
        sheet.addRow({ ...base, desc: t("grvExcel.noProducts") });
      }
      g.lines.forEach((l, i) => {
        const row = sheet.addRow({
          ...(i === 0 ? base : {}),
          sku: l.sku,
          desc: l.name,
          qty: l.qty,
          unit: l.unitValue,
          value: l.value,
        });
        row.getCell("unit").numFmt = moneyFormat;
        row.getCell("value").numFmt = moneyFormat;
      });
      if (g.raisedBy) sheet.addRow({ desc: t("grvExcel.raisedBy", { name: g.raisedBy }) });
      if (g.notes) sheet.addRow({ desc: t("grvExcel.notes", { notes: g.notes }) });
      const creditRow = sheet.addRow({ desc: t("grvExcel.credit", { grv: g.label }), value: g.credit });
      creditRow.getCell("value").numFmt = moneyFormat;
      creditRow.font = { bold: true };
      customerTotal += g.credit;
    }
    if (c.returns.length > 1) {
      const totalRow = sheet.addRow({ desc: t("grvExcel.customerTotal"), value: money(customerTotal) });
      totalRow.getCell("value").numFmt = moneyFormat;
      totalRow.font = { bold: true };
    }
  });

  return wb;
}
