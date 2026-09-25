import "server-only";
import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { InvoiceTemplate, invoiceDate, amountInWordsInvoice, dueDate } from "@/lib/invoice-template";
import type { OrderRow, OrderItemRow } from "@/lib/queries/orders";
import { FALLBACK_VAT_RATE } from "@/lib/money";
import { toFils, toAed } from "@/lib/money";
import { DEFAULT_OVERDUE_DAYS } from "@/lib/queries/aging";
import { t } from "@/lib/i18n";

// The page, the palette and the letterhead below are exported because the
// statement of account (lib/pdf/statement.ts) is drawn from them too: a
// customer who is handed an invoice and a statement should be looking at one
// company's paperwork. Change a colour here and both documents change.
const AED = (n: number) => n.toFixed(2);
export const A4 = { w: 595.28, h: 841.89 };
export const MARGIN = 36;
export const CONTENT_W = A4.w - MARGIN * 2;

export const INK = rgb(0.09, 0.11, 0.1);
export const MUTED = rgb(0.4, 0.44, 0.42);
export const BRAND = rgb(0.09, 0.29, 0.5);
export const SHADE = rgb(0.92, 0.92, 0.92);
export const LINE = rgb(0.75, 0.75, 0.75);

// Column widths for the line-item table — sums to CONTENT_W.
const COLS = {
  no: 20,
  sku: 45,
  desc: 170,
  uos: 32,
  qty: 28,
  price: 42,
  discount: 48,
  netPrice: 50,
  vat: 36,
  netTotal: 52.28,
};

// Figures sit on the right of their column; the header above each one sits
// the same way, so a heading lines up with the numbers under it.
const RIGHT_COLS = new Set<keyof typeof COLS>(["qty", "price", "discount", "netPrice", "vat", "netTotal"]);

// A light rule between every pair of columns, from `top` down `h` points.
function drawColumnRules(page: PDFPage, top: number, h: number) {
  let x = MARGIN;
  const widths = Object.values(COLS);
  for (let i = 0; i < widths.length - 1; i++) {
    x += widths[i];
    page.drawLine({ start: { x, y: top }, end: { x, y: top - h }, thickness: 0.4, color: LINE });
  }
}

export interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  logo?: Awaited<ReturnType<PDFDocument["embedPng"]>>;
  brandStrip?: Awaited<ReturnType<PDFDocument["embedPng"]>>;
}

export function wrapText(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = s.split(/\s+/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const trial = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = trial;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

export async function loadPng(doc: PDFDocument, relPath: string) {
  try {
    const bytes = await readFile(path.join(process.cwd(), "public", relPath));
    return await doc.embedPng(bytes);
  } catch {
    return undefined;
  }
}

// An Admin-uploaded logo (§Global: "Users can upload their own logo. Syncs
// with all data") lives at this fixed public Storage path — invoices pick
// it up automatically, falling back to the bundled default when none has
// been uploaded yet.
export async function loadLogo(doc: PDFDocument) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (base) {
    try {
      const res = await fetch(`${base}/storage/v1/object/public/brand-assets/logo.png`, { cache: "no-store" });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("jpeg") || contentType.includes("jpg")) return await doc.embedJpg(bytes);
        if (contentType.includes("png")) return await doc.embedPng(bytes);
      }
    } catch {
      // fall through to the bundled default below
    }
  }
  return loadPng(doc, "brand/fgt-logo.png");
}

function newPage(ctx: Omit<Ctx, "page">): PDFPage {
  return ctx.doc.addPage([A4.w, A4.h]);
}

// Builds the fixed letterhead (logo + company block + title bar) on a page
// and returns the y-coordinate immediately below it, ready for content.
//
// `kind` names one of the two invoices; any other document passes the title
// it wants in the bar ({ title }).
export function drawLetterhead(ctx: Ctx, kind: "tax" | "performa" | { title: string }): number {
  const { page, font, bold, logo } = ctx;
  let y = A4.h - 30;

  if (logo) {
    const logoH = 56;
    const logoW = logoH * (logo.width / logo.height);
    page.drawImage(logo, { x: MARGIN, y: y - logoH, width: logoW, height: logoH });
  }

  const textX = MARGIN + 130;
  page.drawText(InvoiceTemplate.companyName, { x: textX, y: y - 14, size: 15, font: bold, color: BRAND });
  const detailLine = t("documents.companyDetailLine", {
    licenseNo: InvoiceTemplate.licenseNo,
    trn: InvoiceTemplate.trn,
    email: InvoiceTemplate.email,
    location: InvoiceTemplate.location,
    phone: InvoiceTemplate.phone,
  });
  page.drawText(detailLine, { x: textX, y: y - 30, size: 7.5, font, color: MUTED });

  y -= 66;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 1, color: LINE });

  // Title bar
  const barH = 22;
  y -= barH + 6;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: barH, color: SHADE });
  const title =
    typeof kind === "object" ? kind.title : kind === "tax" ? t("documents.taxInvoice") : t("documents.performaInvoice");
  const titleW = bold.widthOfTextAtSize(title, 13);
  page.drawText(title, { x: MARGIN + (CONTENT_W - titleW) / 2, y: y + 6, size: 13, font: bold, color: INK });

  return y;
}

function drawPartyBox(
  ctx: Ctx,
  label: string,
  x: number,
  w: number,
  top: number,
  bottom: number,
  order: OrderRow
) {
  const { page, font, bold } = ctx;
  page.drawRectangle({ x, y: bottom, width: w, height: top - bottom, borderColor: LINE, borderWidth: 0.75 });
  let y = top - 12;
  page.drawText(label, { x: x + 6, y, size: 9, font: bold, color: INK });
  y -= 14;
  const name = order.customer?.name ?? order.new_customer_note ?? t("common.notSet");
  for (const line of wrapText(name, bold, 9, w - 12)) {
    page.drawText(line, { x: x + 6, y, size: 9, font: bold, color: INK });
    y -= 11;
  }
  const addressLines = [order.customer?.address, order.customer?.district].filter(Boolean) as string[];
  for (const line of addressLines) {
    for (const wrapped of wrapText(line, font, 8, w - 12)) {
      page.drawText(wrapped, { x: x + 6, y, size: 8, font, color: MUTED });
      y -= 10;
    }
  }
  if (order.customer?.vat_number) {
    page.drawText(t("documents.vatNo", { number: order.customer.vat_number }), {
      x: x + 6,
      y: bottom + 9,
      size: 7.5,
      font,
      color: MUTED,
    });
  }
}

function drawInfoBox(ctx: Ctx, x: number, w: number, top: number, bottom: number, order: OrderRow) {
  const { page, font, bold } = ctx;
  page.drawRectangle({ x, y: bottom, width: w, height: top - bottom, borderColor: LINE, borderWidth: 0.75 });
  const rows: [string, string][] = [
    [t("documents.custNo"), order.customer?.code ?? t("common.notSet")],
    [t("documents.invNo"), order.invoice_number ? String(order.invoice_number) : t("common.notSet")],
    [t("documents.invDate"), invoiceDate(order.billed_at ?? order.updated_at ?? order.created_at)],
    [
      t("documents.dueDate"),
      dueDate(order.billed_at ?? order.updated_at ?? order.created_at, order.customer?.overdue_threshold_days ?? DEFAULT_OVERDUE_DAYS),
    ],
    [t("documents.crNo"), t("common.notSet")],
  ];
  const rowH = (top - bottom) / rows.length;
  const labelW = w * 0.42;
  rows.forEach(([label, value], i) => {
    const rowTop = top - i * rowH;
    if (i > 0) {
      page.drawLine({ start: { x, y: rowTop }, end: { x: x + w, y: rowTop }, thickness: 0.5, color: LINE });
    }
    page.drawLine({
      start: { x: x + labelW, y: rowTop },
      end: { x: x + labelW, y: rowTop - rowH },
      thickness: 0.5,
      color: LINE,
    });
    page.drawText(label, { x: x + 5, y: rowTop - rowH / 2 - 3, size: 8, font, color: MUTED });
    page.drawText(value, { x: x + labelW + 5, y: rowTop - rowH / 2 - 3, size: 8, font: bold, color: INK });
  });
}

function drawTableHeader(ctx: Ctx, y: number): number {
  const { page, bold } = ctx;
  const headerH = 18;
  page.drawRectangle({ x: MARGIN, y: y - headerH, width: CONTENT_W, height: headerH, color: SHADE });
  const labels: [string, keyof typeof COLS][] = [
    [t("documents.columnNo"), "no"],
    [t("documents.sku"), "sku"],
    [t("documents.columnDescription"), "desc"],
    [t("documents.columnUos"), "uos"],
    [t("documents.columnQty"), "qty"],
    [t("documents.columnPrice"), "price"],
    [t("documents.columnDiscount"), "discount"],
    [t("documents.columnNetPrice"), "netPrice"],
    [t("documents.vat"), "vat"],
    [t("documents.columnNetTotal"), "netTotal"],
  ];
  let x = MARGIN;
  for (const [label, key] of labels) {
    const w = COLS[key];
    const size = 6.5;
    const tx = RIGHT_COLS.has(key) ? x + w - 4 - bold.widthOfTextAtSize(label, size) : x + 3;
    page.drawText(label, { x: tx, y: y - 12, size, font: bold, color: INK });
    x += w;
  }
  drawColumnRules(page, y, headerH);
  page.drawRectangle({ x: MARGIN, y: y - headerH, width: CONTENT_W, height: headerH, borderColor: LINE, borderWidth: 0.75 });
  return y - headerH;
}

interface LineCalc {
  no: number;
  sku: string;
  desc: string;
  uos: string;
  qty: number;
  price: number;
  discount: number;
  netPrice: number;
  vat: number;
  netTotal: number;
}

// Matches the reference template's per-line arithmetic: NET PRICE is the
// true pre-VAT line amount and VAT is NET PRICE × rate — verified against
// the attached reference PDF's numbers line by line rather than assumed.
// The per-line SUBTOTAL column the template also had was removed at the
// owner's request (2026-09-25).
export function computeInvoiceLines(items: OrderItemRow[], vatRate: number): LineCalc[] {
  return items.map((it, i) => {
    const qty = it.picked_qty ?? it.ordered_qty;
    // order_items.unit_price is the actually-charged price (already net of
    // any discount) — the product's current list price is the closest
    // "should be" reference to derive a per-line discount from, when it's
    // higher than what was actually charged. A negative gap (price raised
    // since the order) is never shown as a "discount".
    const listPrice = Math.max(it.product?.price ?? it.unit_price, it.unit_price);
    const price = listPrice;
    // Every figure printed on a line is computed in fils and rounded once,
    // so the column adds up by hand and matches what was stored on the
    // order. See lib/money.ts.
    const discountFils = Math.max(0, Math.round((toFils(listPrice) - toFils(it.unit_price)) * qty));
    const netPriceFils = Math.round(toFils(price) * qty) - discountFils;
    const vatFilsLine = Math.round(netPriceFils * vatRate);
    const discount = toAed(discountFils);
    const netPrice = toAed(netPriceFils);
    const vatAmt = toAed(vatFilsLine);
    return {
      no: i + 1,
      sku: it.sku,
      desc: it.description ?? it.product_id,
      uos: t("documents.unitOfSaleEach"),
      qty,
      price,
      discount,
      netPrice,
      vat: vatAmt,
      netTotal: netPrice + vatAmt,
    };
  });
}

function drawTableRow(ctx: Ctx, y: number, line: LineCalc): number {
  const { page, font } = ctx;
  const rowH = 15;
  let x = MARGIN;
  const cell = (text: string, w: number, align: "left" | "right" = "left") => {
    const size = 7.5;
    const tw = font.widthOfTextAtSize(text, size);
    const tx = align === "right" ? x + w - 4 - tw : x + 3;
    page.drawText(text, { x: tx, y: y - 11, size, font, color: INK });
    x += w;
  };
  cell(String(line.no), COLS.no);
  cell(line.sku, COLS.sku);
  const descLines = wrapText(line.desc, font, 7.5, COLS.desc - 6);
  page.drawText(descLines[0] ?? "", { x: x + 3, y: y - 11, size: 7.5, font, color: INK });
  x += COLS.desc;
  cell(line.uos, COLS.uos);
  cell(String(line.qty), COLS.qty, "right");
  cell(AED(line.price), COLS.price, "right");
  cell(AED(line.discount), COLS.discount, "right");
  cell(AED(line.netPrice), COLS.netPrice, "right");
  cell(AED(line.vat), COLS.vat, "right");
  cell(AED(line.netTotal), COLS.netTotal, "right");
  page.drawLine({ start: { x: MARGIN, y: y - rowH }, end: { x: A4.w - MARGIN, y: y - rowH }, thickness: 0.4, color: LINE });
  drawColumnRules(page, y, rowH);
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN, y: y - rowH }, thickness: 0.4, color: LINE });
  page.drawLine({ start: { x: A4.w - MARGIN, y }, end: { x: A4.w - MARGIN, y: y - rowH }, thickness: 0.4, color: LINE });
  return y - rowH;
}

export async function buildInvoicePdf(
  order: OrderRow,
  items: OrderItemRow[],
  kind: "tax" | "performa",
  vatRate: number = FALLBACK_VAT_RATE
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const logo = await loadLogo(doc);
  const brandStrip = await loadPng(doc, "brand/brands-footer.png");

  const ctx: Ctx = { doc, page: doc.addPage([A4.w, A4.h]), font, bold, logo, brandStrip };
  let y = drawLetterhead(ctx, kind);

  // Three-column header block (Bill To / Cust-Inv info / Ship To)
  const blockTop = y;
  const blockH = 96;
  const blockBottom = blockTop - blockH;
  const col1W = 170;
  const col2W = 183.28;
  const col3W = CONTENT_W - col1W - col2W;
  drawPartyBox(ctx, t("documents.billTo"), MARGIN, col1W, blockTop, blockBottom, order);
  drawInfoBox(ctx, MARGIN + col1W, col2W, blockTop, blockBottom, order);
  drawPartyBox(ctx, t("documents.shipTo"), MARGIN + col1W + col2W, col3W, blockTop, blockBottom, order);
  y = blockBottom;

  // Salesman row — 6 columns, header + one data row
  const salesLabels = [
    t("documents.salesmanName"),
    t("documents.salesmanNo"),
    t("documents.poNo"),
    t("documents.shippingDate"),
    t("documents.paymentTermsLabel"),
    t("documents.vat"),
  ];
  const salesW = CONTENT_W / 6;
  const salesHeaderH = 16;
  const salesValueH = 18;
  ctx.page.drawRectangle({ x: MARGIN, y: y - salesHeaderH, width: CONTENT_W, height: salesHeaderH, color: SHADE });
  salesLabels.forEach((label, i) => {
    ctx.page.drawText(label, { x: MARGIN + i * salesW + 4, y: y - 11, size: 7.5, font: bold, color: INK });
  });
  const salesValues = [
    order.salesman?.full_name ?? t("common.notSet"),
    order.salesman?.phone ?? "",
    order.po_number ?? "",
    "",
    InvoiceTemplate.paymentTerms,
    order.customer?.vat_number ? `${(vatRate * 100).toFixed(0)}%` : "",
  ];
  const salesRowTop = y - salesHeaderH;
  salesValues.forEach((v, i) => {
    ctx.page.drawText(v, { x: MARGIN + i * salesW + 4, y: salesRowTop - 13, size: 7.5, font, color: INK });
  });
  ctx.page.drawRectangle({
    x: MARGIN,
    y: salesRowTop - salesValueH,
    width: CONTENT_W,
    height: salesHeaderH + salesValueH,
    borderColor: LINE,
    borderWidth: 0.75,
  });
  for (let i = 1; i < 6; i++) {
    const lx = MARGIN + i * salesW;
    ctx.page.drawLine({
      start: { x: lx, y: salesRowTop + salesHeaderH },
      end: { x: lx, y: salesRowTop - salesValueH },
      thickness: 0.5,
      color: LINE,
    });
  }
  y = salesRowTop - salesValueH - 10;

  // Line items table (paginates onto a fresh letterhead page if needed)
  y = drawTableHeader(ctx, y);
  const lines = computeInvoiceLines(items, vatRate);
  const FOOTER_RESERVE = 190;
  for (const line of lines) {
    if (y - 15 < FOOTER_RESERVE) {
      ctx.page = newPage(ctx);
      y = drawLetterhead(ctx, kind);
      y -= 20;
      y = drawTableHeader(ctx, y);
    }
    y = drawTableRow(ctx, y, line);
  }
  ctx.page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: 0, borderColor: LINE, borderWidth: 0.75 });

  // Footer totals + signature blocks
  const footerTotalW = 220;
  // l.price is the list price and l.netPrice is already net of any per-line
  // discount, so "gross" (pre-discount) has to be reconstructed from price×qty
  // rather than reused from netPrice.
  // Summed in fils from the figures already printed on each line, so the
  // footer is the column added up rather than a separate calculation that
  // can land a fil away from it.
  const sumFils = (pick: (l: (typeof lines)[number]) => number) =>
    lines.reduce((sum, l) => sum + toFils(pick(l)), 0);
  const grossSubtotal = toAed(lines.reduce((sum, l) => sum + Math.round(toFils(l.price) * l.qty), 0));
  const discountTotal = toAed(sumFils((l) => l.discount));
  const netSubtotal = toAed(sumFils((l) => l.netPrice));
  const vatTotal = toAed(sumFils((l) => l.vat));
  const grandTotal = toAed(sumFils((l) => l.netTotal));
  let fy = y - 18;
  const footerRow = (label: string, value: string, boldRow = false) => {
    ctx.page.drawText(label, { x: MARGIN, y: fy, size: boldRow ? 10 : 8.5, font: boldRow ? bold : font, color: boldRow ? INK : MUTED });
    ctx.page.drawText(value, { x: MARGIN + footerTotalW - font.widthOfTextAtSize(value, boldRow ? 10 : 8.5), y: fy, size: boldRow ? 10 : 8.5, font: boldRow ? bold : font, color: INK });
    fy -= boldRow ? 16 : 14;
  };
  // §Orders PDF: "add a discount above the grand total" — only shown when
  // there actually was one, so an undiscounted invoice's footer is
  // unchanged from before.
  if (discountTotal > 0.005) {
    footerRow(t("documents.subtotalWithoutVat"), AED(grossSubtotal));
    footerRow(t("documents.discount"), `-${AED(discountTotal)}`);
  } else {
    footerRow(t("documents.subtotalWithoutVat"), AED(netSubtotal));
  }
  footerRow(t("documents.vatTotal"), AED(vatTotal));
  footerRow(t("documents.grandTotal"), AED(grandTotal), true);
  fy -= 4;
  ctx.page.drawText(t("documents.amountInWords"), { x: MARGIN, y: fy, size: 8, font: bold, color: INK });
  fy -= 11;
  for (const line of wrapText(amountInWordsInvoice(grandTotal), font, 8, footerTotalW)) {
    ctx.page.drawText(line, { x: MARGIN, y: fy, size: 8, font, color: MUTED });
    fy -= 10;
  }

  const sigX = MARGIN + footerTotalW + 20;
  const sigW = CONTENT_W - footerTotalW - 20;
  let sy = y - 18;
  ctx.page.drawText(t("documents.customerSignatureLine1"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText(t("documents.customerSignatureLine2"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 40;
  ctx.page.drawText(t("documents.companySignatureLine1"), { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText(t("documents.companySignatureLine2"), { x: sigX, y: sy, size: 8, font: bold, color: INK });

  // Brand strip at the very bottom
  if (brandStrip) {
    const stripW = CONTENT_W;
    const stripH = stripW / (brandStrip.width / brandStrip.height);
    ctx.page.drawImage(brandStrip, { x: MARGIN, y: 20, width: stripW, height: Math.min(stripH, 40) });
  }

  return doc.save();
}
