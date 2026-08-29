import "server-only";
import { readFile } from "fs/promises";
import path from "path";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { InvoiceTemplate, invoiceDate, amountInWordsInvoice, dueDate } from "@/lib/invoice-template";
import type { OrderRow, OrderItemRow } from "@/lib/queries/orders";
import { FALLBACK_VAT_RATE } from "@/lib/money";

const AED = (n: number) => n.toFixed(2);
const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 36;
const CONTENT_W = A4.w - MARGIN * 2;

const INK = rgb(0.09, 0.11, 0.1);
const MUTED = rgb(0.4, 0.44, 0.42);
const BRAND = rgb(0.09, 0.29, 0.5);
const SHADE = rgb(0.92, 0.92, 0.92);
const LINE = rgb(0.75, 0.75, 0.75);

// Column widths for the line-item table — sums to CONTENT_W.
const COLS = {
  no: 20,
  sku: 45,
  desc: 122,
  uos: 32,
  qty: 28,
  price: 42,
  discount: 48,
  netPrice: 50,
  subtotal: 48,
  vat: 36,
  netTotal: 52.28,
};

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  font: PDFFont;
  bold: PDFFont;
  logo?: Awaited<ReturnType<PDFDocument["embedPng"]>>;
  brandStrip?: Awaited<ReturnType<PDFDocument["embedPng"]>>;
}

function wrapText(s: string, font: PDFFont, size: number, maxWidth: number): string[] {
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

async function loadPng(doc: PDFDocument, relPath: string) {
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
async function loadLogo(doc: PDFDocument) {
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
function drawLetterhead(ctx: Ctx, kind: "tax" | "performa"): number {
  const { page, font, bold, logo } = ctx;
  let y = A4.h - 30;

  if (logo) {
    const logoH = 56;
    const logoW = logoH * (logo.width / logo.height);
    page.drawImage(logo, { x: MARGIN, y: y - logoH, width: logoW, height: logoH });
  }

  const textX = MARGIN + 130;
  page.drawText(InvoiceTemplate.companyName, { x: textX, y: y - 14, size: 15, font: bold, color: BRAND });
  const detailLine = `License No:${InvoiceTemplate.licenseNo} | TRN No.:${InvoiceTemplate.trn} | ${InvoiceTemplate.email} | ${InvoiceTemplate.location} | Ph:${InvoiceTemplate.phone}`;
  page.drawText(detailLine, { x: textX, y: y - 30, size: 7.5, font, color: MUTED });

  y -= 66;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: A4.w - MARGIN, y }, thickness: 1, color: LINE });

  // Title bar
  const barH = 22;
  y -= barH + 6;
  page.drawRectangle({ x: MARGIN, y, width: CONTENT_W, height: barH, color: SHADE });
  const title = kind === "tax" ? "TAX INVOICE" : "PERFORMA INVOICE";
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
  const name = order.customer?.name ?? order.new_customer_note ?? "—";
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
    page.drawText(`VAT No: ${order.customer.vat_number}`, {
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
    ["Cust No", order.customer?.code ?? "—"],
    ["Inv No.", order.invoice_number ? String(order.invoice_number) : "—"],
    ["Inv Date", invoiceDate(order.updated_at ?? order.created_at)],
    [
      "Due Date",
      dueDate(order.updated_at ?? order.created_at, order.customer?.overdue_threshold_days ?? 30),
    ],
    ["CR No.", "—"],
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
  const labels: [string, number][] = [
    ["NO.", COLS.no],
    ["SKU", COLS.sku],
    ["DESCRIPTION", COLS.desc],
    ["UOS", COLS.uos],
    ["QTY", COLS.qty],
    ["PRICE", COLS.price],
    ["DISCOUNT", COLS.discount],
    ["NET PRICE", COLS.netPrice],
    ["SUBTOTAL", COLS.subtotal],
    ["VAT", COLS.vat],
    ["NET TOTAL", COLS.netTotal],
  ];
  let x = MARGIN;
  for (const [label, w] of labels) {
    page.drawText(label, { x: x + 3, y: y - 12, size: 6.5, font: bold, color: INK });
    x += w;
  }
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
  lineSubtotal: number;
  vat: number;
  netTotal: number;
}

// Matches the reference template's exact (if slightly unconventional)
// per-line arithmetic: NET PRICE is the true pre-VAT line amount, VAT is
// NET PRICE × rate, and the per-line "SUBTOTAL" column is NET PRICE minus
// that VAT (not the same thing as the footer's "Subtotal without VAT",
// which sums NET PRICE directly) — verified against the attached reference
// PDF's numbers line by line rather than assumed.
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
    const discount = Math.max(0, (listPrice - it.unit_price) * qty);
    const netPrice = price * qty - discount;
    const vatAmt = netPrice * vatRate;
    return {
      no: i + 1,
      sku: it.sku,
      desc: it.description ?? it.product_id,
      uos: "Each",
      qty,
      price,
      discount,
      netPrice,
      lineSubtotal: netPrice - vatAmt,
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
  cell(AED(line.lineSubtotal), COLS.subtotal, "right");
  cell(AED(line.vat), COLS.vat, "right");
  cell(AED(line.netTotal), COLS.netTotal, "right");
  page.drawLine({ start: { x: MARGIN, y: y - rowH }, end: { x: A4.w - MARGIN, y: y - rowH }, thickness: 0.4, color: LINE });
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
  drawPartyBox(ctx, "Bill To:", MARGIN, col1W, blockTop, blockBottom, order);
  drawInfoBox(ctx, MARGIN + col1W, col2W, blockTop, blockBottom, order);
  drawPartyBox(ctx, "Ship To:", MARGIN + col1W + col2W, col3W, blockTop, blockBottom, order);
  y = blockBottom;

  // Salesman row — 6 columns, header + one data row
  const salesLabels = ["Salesman Name", "Salesman No.", "P.O. No.", "Shipping Date", "Payment Terms", "VAT"];
  const salesW = CONTENT_W / 6;
  const salesHeaderH = 16;
  const salesValueH = 18;
  ctx.page.drawRectangle({ x: MARGIN, y: y - salesHeaderH, width: CONTENT_W, height: salesHeaderH, color: SHADE });
  salesLabels.forEach((label, i) => {
    ctx.page.drawText(label, { x: MARGIN + i * salesW + 4, y: y - 11, size: 7.5, font: bold, color: INK });
  });
  const salesValues = [
    order.salesman?.full_name ?? "—",
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
  const grossSubtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
  const discountTotal = lines.reduce((s, l) => s + l.discount, 0);
  const netSubtotal = lines.reduce((s, l) => s + l.netPrice, 0);
  const vatTotal = lines.reduce((s, l) => s + l.vat, 0);
  const grandTotal = lines.reduce((s, l) => s + l.netTotal, 0);
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
    footerRow("Subtotal without VAT", AED(grossSubtotal));
    footerRow("Discount", `-${AED(discountTotal)}`);
  } else {
    footerRow("Subtotal without VAT", AED(netSubtotal));
  }
  footerRow("VAT Total", AED(vatTotal));
  footerRow("Grand Total", AED(grandTotal), true);
  fy -= 4;
  ctx.page.drawText("Amount in Words:", { x: MARGIN, y: fy, size: 8, font: bold, color: INK });
  fy -= 11;
  for (const line of wrapText(amountInWordsInvoice(grandTotal), font, 8, footerTotalW)) {
    ctx.page.drawText(line, { x: MARGIN, y: fy, size: 8, font, color: MUTED });
    fy -= 10;
  }

  const sigX = MARGIN + footerTotalW + 20;
  const sigW = CONTENT_W - footerTotalW - 20;
  let sy = y - 18;
  ctx.page.drawText("Customer: Name, Signature,", { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText("Stamp, Mobile No.", { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 40;
  ctx.page.drawText("Company: Name, Signature,", { x: sigX, y: sy, size: 8, font: bold, color: INK });
  sy -= 10;
  ctx.page.drawText("Mobile No.", { x: sigX, y: sy, size: 8, font: bold, color: INK });

  // Brand strip at the very bottom
  if (brandStrip) {
    const stripW = CONTENT_W;
    const stripH = stripW / (brandStrip.width / brandStrip.height);
    ctx.page.drawImage(brandStrip, { x: MARGIN, y: 20, width: stripW, height: Math.min(stripH, 40) });
  }

  return doc.save();
}
