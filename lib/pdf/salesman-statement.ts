import "server-only";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { A4, MARGIN, CONTENT_W, INK, MUTED, SHADE, LINE, drawLetterhead, loadLogo, loadPng, type Ctx } from "@/lib/pdf/invoice";
import { AED, ROW_H, HEADER_H, FOOT_LIMIT, cellText, drawBrandStrip } from "@/lib/pdf/statement";
import type { SalesmanStatement } from "@/lib/statement";
import { t } from "@/lib/i18n";

// The salesman-wise statement, in the same dress as the customer statement and
// the invoice (shared letterhead, palette and table pieces — nothing copied).
// One salesman, every invoice of theirs that still has a balance, customer by
// customer. An overdue row carries "OVERDUE" in its last column rather than a
// colour: these are printed in black and white and handed across a desk.

const COLS: { key: string; label: Parameters<typeof t>[0]; w: number; right?: boolean }[] = [
  { key: "date", label: "customers.stmtColDate", w: 54 },
  { key: "inv", label: "customers.stmtColInvNo", w: 46 },
  { key: "customer", label: "reports.ssColCustomer", w: 151.28 },
  { key: "payable", label: "customers.stmtColTotalPayable", w: 70, right: true },
  { key: "received", label: "customers.stmtColReceived", w: 62, right: true },
  { key: "balance", label: "customers.stmtColBalance", w: 66, right: true },
  { key: "days", label: "customers.stmtColDays", w: 74, right: true },
];

function drawHeader(ctx: Ctx, y: number): number {
  ctx.page.drawRectangle({ x: MARGIN, y: y - HEADER_H, width: CONTENT_W, height: HEADER_H, color: SHADE });
  let x = MARGIN;
  for (const col of COLS) {
    cellText(ctx, t(col.label), x, col.w, y - 12, ctx.bold, 6.5, col.right);
    x += col.w;
  }
  ctx.page.drawRectangle({ x: MARGIN, y: y - HEADER_H, width: CONTENT_W, height: HEADER_H, borderColor: LINE, borderWidth: 0.75 });
  return y - HEADER_H;
}

function fit(text: string, font: Ctx["font"], size: number, maxW: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxW) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}…`, size) > maxW) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

export async function buildSalesmanStatementPdf(
  salesmanName: string,
  statement: SalesmanStatement,
  statementDate: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(doc);
  const brandStrip = await loadPng(doc, "brand/brands-footer.png");
  const title = t("reports.ssTitle");
  doc.setTitle(`${title} — ${salesmanName}`);

  const ctx: Ctx = { doc, page: doc.addPage([A4.w, A4.h]), font, bold, logo, brandStrip };
  let y = drawLetterhead(ctx, { title });

  // ---- Whose it is (left) and the account at a glance (right) ----
  const blockTop = y - 8;
  const blockH = 84;
  const blockBottom = blockTop - blockH;
  const gap = 10;
  const leftW = (CONTENT_W - gap) * 0.52;
  const rightW = CONTENT_W - gap - leftW;
  const rightX = MARGIN + leftW + gap;

  ctx.page.drawRectangle({ x: MARGIN, y: blockBottom, width: leftW, height: blockH, borderColor: LINE, borderWidth: 0.75 });
  ctx.page.drawText(t("reports.ssSalesman"), { x: MARGIN + 6, y: blockTop - 12, size: 9, font: bold, color: INK });
  ctx.page.drawText(fit(salesmanName, bold, 11.5, leftW - 12), { x: MARGIN + 6, y: blockTop - 28, size: 11.5, font: bold, color: INK });
  ctx.page.drawText(t("reports.ssExplainer"), { x: MARGIN + 6, y: blockTop - 42, size: 8, font, color: MUTED });
  ctx.page.drawText(
    t("reports.ssCounts", { invoices: statement.rows.length, customers: statement.totals.customers }),
    { x: MARGIN + 6, y: blockBottom + 9, size: 7.5, font, color: MUTED }
  );

  ctx.page.drawRectangle({ x: rightX, y: blockBottom, width: rightW, height: blockH, borderColor: LINE, borderWidth: 0.75 });
  const summary: [string, string, boolean][] = [
    [t("customers.stmtStatementDate"), statementDate, false],
    [t("customers.stmtTotalInvoiced"), AED(statement.totals.totalPayable), false],
    [t("reports.ssOverdue"), AED(statement.totals.overdue), false],
    [t("reports.ssToCollect"), `${AED(statement.totals.balance)} ${t("customers.stmtCurrency")}`, true],
  ];
  const sumRowH = blockH / summary.length;
  summary.forEach(([label, value, strong], i) => {
    const rowTop = blockTop - i * sumRowH;
    if (i > 0) ctx.page.drawLine({ start: { x: rightX, y: rowTop }, end: { x: rightX + rightW, y: rowTop }, thickness: 0.5, color: LINE });
    if (strong) {
      ctx.page.drawRectangle({ x: rightX, y: rowTop - sumRowH, width: rightW, height: sumRowH, color: SHADE });
      ctx.page.drawRectangle({ x: rightX, y: rowTop - sumRowH, width: rightW, height: sumRowH, borderColor: LINE, borderWidth: 0.75 });
    }
    const ty = rowTop - sumRowH / 2 - 3;
    const f = strong ? bold : font;
    const size = strong ? 9.5 : 8.5;
    ctx.page.drawText(label, { x: rightX + 6, y: ty, size: 8, font: f, color: strong ? INK : MUTED });
    ctx.page.drawText(value, { x: rightX + rightW - 6 - f.widthOfTextAtSize(value, size), y: ty, size, font: f, color: INK });
  });

  // ---- The ledger ----
  y = drawHeader(ctx, blockBottom - 12);
  let tableTop = y + HEADER_H;
  const closeTable = (bottom: number) =>
    ctx.page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_W, height: tableTop - bottom, borderColor: LINE, borderWidth: 0.75 });
  const nextPage = () => {
    closeTable(y);
    drawBrandStrip(ctx);
    ctx.page = doc.addPage([A4.w, A4.h]);
    y = drawLetterhead(ctx, { title });
    ctx.page.drawText(salesmanName, { x: MARGIN, y: y - 14, size: 9, font: bold, color: INK });
    y = drawHeader(ctx, y - 22);
    tableTop = y + HEADER_H;
  };

  if (statement.rows.length === 0) {
    ctx.page.drawText(t("reports.ssNothingOwed"), { x: MARGIN + 4, y: y - 12, size: 8, font, color: MUTED });
    y -= ROW_H;
  }
  for (const r of statement.rows) {
    if (y - ROW_H < FOOT_LIMIT) nextPage();
    const customer = fit(`${r.customerName}${r.customerCode ? ` (${r.customerCode})` : ""}`, font, 7.5, COLS[2].w - 8);
    const values: Record<string, string> = {
      date: new Date(r.date).toLocaleDateString("en-GB"),
      inv: r.invNo,
      customer,
      payable: AED(r.totalPayable),
      received: r.received ? AED(r.received) : "",
      balance: AED(r.balance),
      days: r.overdue ? t("reports.ssDaysOverdue", { n: r.days }) : String(r.days),
    };
    let x = MARGIN;
    for (const col of COLS) {
      const strong = col.key === "balance" || (col.key === "days" && r.overdue);
      cellText(ctx, values[col.key], x, col.w, y - 11, strong ? bold : font, 7.5, col.right);
      x += col.w;
    }
    y -= ROW_H;
    ctx.page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.4, color: LINE });
  }

  if (y - ROW_H < FOOT_LIMIT) nextPage();
  ctx.page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: CONTENT_W, height: ROW_H, color: SHADE });
  const totals: Record<string, string> = {
    date: t("customers.stmtTotals"),
    payable: AED(statement.totals.totalPayable),
    received: AED(statement.totals.received),
    balance: AED(statement.totals.balance),
  };
  let tx = MARGIN;
  for (const col of COLS) {
    if (totals[col.key]) cellText(ctx, totals[col.key], tx, col.w, y - 11, bold, 7.5, col.right);
    tx += col.w;
  }
  y -= ROW_H;
  closeTable(y);

  if (y - 40 < FOOT_LIMIT) {
    drawBrandStrip(ctx);
    ctx.page = doc.addPage([A4.w, A4.h]);
    y = drawLetterhead(ctx, { title });
  }
  ctx.page.drawText(t("reports.ssToCollectLine", { amount: AED(statement.totals.balance) }), {
    x: MARGIN,
    y: y - 20,
    size: 10,
    font: bold,
    color: INK,
  });
  drawBrandStrip(ctx);

  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = t("customers.stmtPageOf", { page: i + 1, total: pages.length });
      p.drawText(label, { x: A4.w - MARGIN - font.widthOfTextAtSize(label, 7.5), y: 64, size: 7.5, font, color: MUTED });
    });
  }
  return doc.save();
}
