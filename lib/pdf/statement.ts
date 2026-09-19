import "server-only";
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib";
import {
  A4,
  MARGIN,
  CONTENT_W,
  INK,
  MUTED,
  SHADE,
  LINE,
  drawLetterhead,
  loadLogo,
  loadPng,
  wrapText,
  type Ctx,
} from "@/lib/pdf/invoice";
import { InvoiceTemplate } from "@/lib/invoice-template";
import type { Statement, StatementScope } from "@/lib/statement";
import { t } from "@/lib/i18n";

// The statement of account, drawn as the invoice is drawn (owner, 2026-09-18:
// "make the statement PDF similar design to the invoices"): the same
// letterhead and logo, the same shaded title bar, a boxed "Bill To" beside a
// boxed summary, a ruled table under a shaded header, totals bottom-left and
// the brand strip along the foot. Everything that decides how the two look —
// page, margins, palette, letterhead — is imported from lib/pdf/invoice.ts
// rather than copied, so they cannot drift apart.
//
// It also runs to as many pages as the account needs. The old one stopped
// drawing at the bottom of page one and printed the closing balance of rows
// it had silently left out.

export const AED = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export interface StatementParty {
  code: string;
  name: string;
  district: string | null;
  address?: string | null;
  vat_number?: string | null;
}

// Column widths — sum to CONTENT_W (523.28). Money columns are right-aligned
// so the decimal points stack, which Helvetica's equal-width digits allow.
const COLS: { key: string; label: string; w: number; right?: boolean }[] = [
  { key: "date", label: "customers.stmtColDate", w: 56 },
  { key: "inv", label: "customers.stmtColInvNo", w: 50 },
  { key: "desc", label: "customers.stmtColDescription", w: 73.28 },
  { key: "amount", label: "customers.stmtColInvoiceAmount", w: 68, right: true },
  { key: "vat", label: "customers.stmtColVat", w: 48, right: true },
  { key: "payable", label: "customers.stmtColTotalPayable", w: 70, right: true },
  { key: "received", label: "customers.stmtColReceived", w: 62, right: true },
  { key: "balance", label: "customers.stmtColBalance", w: 64, right: true },
  { key: "days", label: "customers.stmtColDays", w: 32, right: true },
];

export const ROW_H = 16;
export const HEADER_H = 18;
export const FOOT_LIMIT = 70; // keep clear of the brand strip

export function cellText(
  ctx: Ctx,
  text: string,
  x: number,
  w: number,
  y: number,
  font: PDFFont,
  size: number,
  right: boolean | undefined,
  color = INK
) {
  const tx = right ? x + w - 4 - font.widthOfTextAtSize(text, size) : x + 4;
  ctx.page.drawText(text, { x: tx, y, size, font, color });
}

function drawTableHeader(ctx: Ctx, y: number): number {
  const { page, bold } = ctx;
  page.drawRectangle({ x: MARGIN, y: y - HEADER_H, width: CONTENT_W, height: HEADER_H, color: SHADE });
  let x = MARGIN;
  for (const col of COLS) {
    cellText(ctx, t(col.label as Parameters<typeof t>[0]), x, col.w, y - 12, bold, 6.5, col.right);
    x += col.w;
  }
  page.drawRectangle({ x: MARGIN, y: y - HEADER_H, width: CONTENT_W, height: HEADER_H, borderColor: LINE, borderWidth: 0.75 });
  return y - HEADER_H;
}

export function drawBrandStrip(ctx: Ctx) {
  if (!ctx.brandStrip) return;
  const stripH = CONTENT_W / (ctx.brandStrip.width / ctx.brandStrip.height);
  ctx.page.drawImage(ctx.brandStrip, { x: MARGIN, y: 20, width: CONTENT_W, height: Math.min(stripH, 40) });
}

export async function buildStatementPdf(
  customer: StatementParty,
  statement: Statement,
  statementDate: string,
  /// >0 when this covers a shop group rather than one shop.
  groupShopCount = 0,
  scope: StatementScope = "outstanding"
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(doc);
  const brandStrip = await loadPng(doc, "brand/brands-footer.png");
  const title = scope === "paid" ? t("customers.statementOfAccountPaid") : t("customers.statementOfAccount");
  doc.setTitle(`${title} — ${customer.name}`);

  const ctx: Ctx = { doc, page: doc.addPage([A4.w, A4.h]), font, bold, logo, brandStrip };
  let y = drawLetterhead(ctx, { title });

  // ---- Bill To (left) and the account at a glance (right) ----
  const blockTop = y - 8;
  const blockH = 84;
  const blockBottom = blockTop - blockH;
  const gap = 10;
  const leftW = (CONTENT_W - gap) * 0.58;
  const rightW = CONTENT_W - gap - leftW;
  const rightX = MARGIN + leftW + gap;

  ctx.page.drawRectangle({ x: MARGIN, y: blockBottom, width: leftW, height: blockH, borderColor: LINE, borderWidth: 0.75 });
  let ly = blockTop - 12;
  ctx.page.drawText(t("documents.billTo"), { x: MARGIN + 6, y: ly, size: 9, font: bold, color: INK });
  ly -= 14;
  const heading = groupShopCount > 0 ? customer.name : `${customer.name} (${customer.code})`;
  // The customer's name is the point of the page: set larger than anything
  // else in the box, so whoever is handed this knows at once whose it is.
  ly -= 2;
  for (const line of wrapText(heading, bold, 11.5, leftW - 12).slice(0, 2)) {
    ctx.page.drawText(line, { x: MARGIN + 6, y: ly, size: 11.5, font: bold, color: INK });
    ly -= 14;
  }
  const partyLines = [
    groupShopCount > 0 ? t("customers.combinedAccount", { n: groupShopCount }) : null,
    customer.address ?? null,
    customer.district,
  ].filter(Boolean) as string[];
  for (const raw of partyLines) {
    for (const line of wrapText(raw, font, 8, leftW - 12).slice(0, 2)) {
      if (ly < blockBottom + 18) break;
      ctx.page.drawText(line, { x: MARGIN + 6, y: ly, size: 8, font, color: MUTED });
      ly -= 10;
    }
  }
  if (customer.vat_number) {
    ctx.page.drawText(t("documents.vatNo", { number: customer.vat_number }), {
      x: MARGIN + 6,
      y: blockBottom + 9,
      size: 7.5,
      font,
      color: MUTED,
    });
  }

  // The same ruled label/value rows the invoice's info box uses.
  ctx.page.drawRectangle({ x: rightX, y: blockBottom, width: rightW, height: blockH, borderColor: LINE, borderWidth: 0.75 });
  const summary: [string, string, boolean][] = [
    [t("customers.stmtStatementDate"), statementDate, false],
    [t("customers.stmtTotalInvoiced"), AED(statement.totals.totalPayable), false],
    [t("customers.stmtTotalReceived"), AED(statement.totals.received), false],
    [
      scope === "paid" ? t("customers.stmtTotalPaid") : t("customers.stmtBalanceDue"),
      `${AED(scope === "paid" ? statement.totals.received : statement.totals.balance)} ${t("customers.stmtCurrency")}`,
      true,
    ],
  ];
  const sumRowH = blockH / summary.length;
  summary.forEach(([label, value, strong], i) => {
    const rowTop = blockTop - i * sumRowH;
    if (i > 0) {
      ctx.page.drawLine({ start: { x: rightX, y: rowTop }, end: { x: rightX + rightW, y: rowTop }, thickness: 0.5, color: LINE });
    }
    if (strong) {
      ctx.page.drawRectangle({ x: rightX, y: rowTop - sumRowH, width: rightW, height: sumRowH, color: SHADE });
      ctx.page.drawRectangle({ x: rightX, y: rowTop - sumRowH, width: rightW, height: sumRowH, borderColor: LINE, borderWidth: 0.75 });
    }
    const ty = rowTop - sumRowH / 2 - 3;
    ctx.page.drawText(label, { x: rightX + 6, y: ty, size: 8, font: strong ? bold : font, color: strong ? INK : MUTED });
    const f = strong ? bold : font;
    const size = strong ? 9.5 : 8.5;
    ctx.page.drawText(value, { x: rightX + rightW - 6 - f.widthOfTextAtSize(value, size), y: ty, size, font: f, color: INK });
  });

  // ---- The ledger ----
  y = drawTableHeader(ctx, blockBottom - 12);
  const tableTops: number[] = [y + HEADER_H];

  const closeTable = (top: number, bottom: number) => {
    ctx.page.drawRectangle({ x: MARGIN, y: bottom, width: CONTENT_W, height: top - bottom, borderColor: LINE, borderWidth: 0.75 });
  };

  if (statement.rows.length === 0) {
    ctx.page.drawText(scope === "paid" ? t("customers.stmtNoPaid") : scope === "outstanding" ? t("customers.stmtNothingDue") : t("customers.stmtNoEntries"), { x: MARGIN + 4, y: y - 12, size: 8, font, color: MUTED });
    y -= ROW_H;
  }

  for (const r of statement.rows) {
    if (y - ROW_H < FOOT_LIMIT) {
      closeTable(tableTops[tableTops.length - 1], y);
      drawBrandStrip(ctx);
      ctx.page = doc.addPage([A4.w, A4.h]);
      y = drawLetterhead(ctx, { title });
      // A loose second page still says whose statement it is.
      ctx.page.drawText(heading, { x: MARGIN, y: y - 14, size: 9, font: bold, color: INK });
      y = drawTableHeader(ctx, y - 22);
      tableTops.push(y + HEADER_H);
    }
    const isCredit = r.description === "GRV";
    const values: Record<string, string> = {
      date: new Date(r.date).toLocaleDateString("en-GB"),
      inv: r.invNo,
      desc: isCredit ? t("customers.stmtGoodsReturn") : t("customers.stmtInvoice"),
      amount: AED(r.invoiceAmount),
      vat: AED(r.vat),
      payable: AED(r.totalPayable),
      received: r.received ? AED(r.received) : "",
      balance: AED(r.balance),
      days: String(r.days),
    };
    let x = MARGIN;
    for (const col of COLS) {
      const strong = col.key === "balance";
      cellText(ctx, values[col.key], x, col.w, y - 11, strong ? bold : font, 7.5, col.right, isCredit && !strong ? MUTED : INK);
      x += col.w;
    }
    y -= ROW_H;
    ctx.page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 0.4, color: LINE });
  }

  // Totals row, shaded like the header, closing the table.
  if (y - ROW_H < FOOT_LIMIT) {
    closeTable(tableTops[tableTops.length - 1], y);
    drawBrandStrip(ctx);
    ctx.page = doc.addPage([A4.w, A4.h]);
    y = drawLetterhead(ctx, { title }) - 12;
    tableTops.push(y);
  }
  ctx.page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: CONTENT_W, height: ROW_H, color: SHADE });
  const totals: Record<string, string> = {
    date: t("customers.stmtTotals"),
    amount: AED(statement.totals.invoiceAmount),
    vat: AED(statement.totals.vat),
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
  closeTable(tableTops[tableTops.length - 1], y);

  // ---- Footer: amount due + how to pay (left), signatures (right) ----
  const footerNeeds = 96;
  if (y - footerNeeds < FOOT_LIMIT) {
    drawBrandStrip(ctx);
    ctx.page = doc.addPage([A4.w, A4.h]);
    y = drawLetterhead(ctx, { title });
  }
  const footerW = 345;
  let fy = y - 20;
  const closing =
    scope === "paid"
      ? t("customers.stmtTotalPaidLine", { amount: AED(statement.totals.received) })
      : t("customers.amountDue", { amount: AED(statement.totals.balance) });
  ctx.page.drawText(closing, {
    x: MARGIN,
    y: fy,
    size: 10,
    font: bold,
    color: INK,
  });
  fy -= 16;
  const payLines = [
    t("customers.paymentTerms", { terms: InvoiceTemplate.paymentTerms }),
    InvoiceTemplate.bankLine1,
    InvoiceTemplate.bankLine2,
  ];
  for (const raw of payLines) {
    for (const line of wrapText(raw, font, 8, footerW)) {
      ctx.page.drawText(line, { x: MARGIN, y: fy, size: 8, font, color: MUTED });
      fy -= 10;
    }
    fy -= 2;
  }

  const sigX = MARGIN + footerW + 20;
  let sy = y - 20;
  ctx.page.drawText(t("documents.customerSignatureLine1"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText(t("documents.customerSignatureLine2"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 40;
  ctx.page.drawText(t("documents.companySignatureLine1"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText(t("documents.companySignatureLine2"), { x: sigX, y: sy, size: 8, font: bold, color: INK });

  drawBrandStrip(ctx);

  // "Page 1 of 3", only when there is more than one — a one-page statement
  // looks exactly like an invoice, which has no page number either.
  const pages = doc.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) => {
      const label = t("customers.stmtPageOf", { page: i + 1, total: pages.length });
      p.drawText(label, { x: A4.w - MARGIN - font.widthOfTextAtSize(label, 7.5), y: 64, size: 7.5, font, color: MUTED });
    });
  }

  return doc.save();
}
