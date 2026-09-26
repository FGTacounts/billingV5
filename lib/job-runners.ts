import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppUser } from "@/lib/types/db";
import type { JobKind } from "@/lib/jobs";
import { fetchOrders, fetchOrderItems } from "@/lib/queries/orders";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";
import { fetchProductsServer } from "@/lib/products-server";
import { fetchAllPages } from "@/lib/paging";
import { scanOrderImage, scanArticlesDoc, type ScannedArticle } from "@/lib/ai-scan";

/**
 * The work itself, lifted out of the four request handlers that used to do it
 * inline so that the queue worker and those handlers run exactly the same
 * code. The handlers are still there and still work — they are what runs when
 * the `jobs` table has not been created yet (see lib/jobs.ts,
 * JobQueueUnavailable) — but neither copy can now drift from the other.
 */

/** Something wrong with what was asked for, rather than something that broke. */
export class JobInputError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "JobInputError";
    this.status = status;
  }
}

/** Who may ask for each kind. The same gate the old handlers applied. */
export function roleAllowsJob(kind: JobKind, user: AppUser): boolean {
  // Reading a paper order off a pad is the salesman's job and the reason
  // scanning exists, so that one is open to every signed-in role. The other
  // three read or write cost prices, or export every invoice in the business.
  if (kind === "scan.order") return true;
  return user.role === "manager" || user.role === "admin";
}

// ---------------------------------------------------------------------------
// invoices.zip — every delivered order's Tax Invoice
// ---------------------------------------------------------------------------

// Unchanged from the handler this replaces: the export is the most recent 200
// delivered orders.
export const MAX_INVOICE_ORDERS = 200;

// How many PDFs one worker request builds before handing the job back to the
// queue. The whole point of the queue is that no single request has to finish
// all 200, so this is sized to be comfortably inside any platform's limit
// rather than to be as large as possible.
export const INVOICE_SLICE = 20;

export interface InvoiceFile {
  name: string;
  /** The PDF itself. Never stored on the job row — only passed back. */
  base64: string;
}

/**
 * The orders this export covers, resolved once and then held on the job.
 *
 * Fixing the list up front is what makes the slices add up: an order
 * delivered while the export is halfway through does not shuffle the ones
 * behind it into being built twice or not at all.
 */
export async function planInvoiceExport(db: SupabaseClient): Promise<string[]> {
  const orders = await fetchOrders(db, { status: ["delivered"], limit: MAX_INVOICE_ORDERS });
  if (orders.length === 0) {
    throw new JobInputError("No delivered invoices to export.", 404);
  }
  return orders.map((o) => o.id);
}

/**
 * Build the PDFs for one slice of the planned list.
 *
 * `usedNames` carries the names already taken by earlier slices, so two
 * orders sharing an invoice number still get two files rather than one
 * overwriting the other — the same de-duplication the single-request version
 * did with a Set it held for the length of one loop.
 */
export async function buildInvoiceSlice(
  db: SupabaseClient,
  orderIds: string[],
  usedNames: string[]
): Promise<InvoiceFile[]> {
  if (orderIds.length === 0) return [];

  const { data: settings } = await db.from("app_settings").select("vat_rate").limit(1).maybeSingle();

  // fetchOrders is one query and gives the customer and salesman joins the
  // invoice layout needs; the ids decide which of them this slice is for.
  const all = await fetchOrders(db, { status: ["delivered"], limit: MAX_INVOICE_ORDERS });
  const byId = new Map(all.map((o) => [o.id, o]));

  const taken = new Set(usedNames);
  const files: InvoiceFile[] = [];

  for (const id of orderIds) {
    const order = byId.get(id);
    // An order that has left `delivered` since the export was planned is no
    // longer an invoice to hand over. Skipped, not failed.
    if (!order) continue;

    const items = await fetchOrderItems(db, order.id);
    const bytes = await buildInvoicePdf(order, items, "tax", settings?.vat_rate);
    const base = invoiceFileBase(order.invoice_number, order.billed_at ?? order.updated_at ?? order.created_at);
    let name = `${base}.pdf`;
    while (taken.has(name)) name = `${base}-${order.id.slice(0, 6)}.pdf`;
    taken.add(name);
    files.push({ name, base64: Buffer.from(bytes).toString("base64") });
  }

  return files;
}

// ---------------------------------------------------------------------------
// orders.import — a day's orders from one spreadsheet
// ---------------------------------------------------------------------------

export interface ImportRow {
  invoice?: string;
  customer?: string;
  sku?: string;
  qty?: string;
  price?: string;
  salesman?: string;
  // Optional, like price and salesman: the customer's purchase-order number,
  // and anything the person who wrote the sheet wants the manager to read.
  po_number?: string;
  note?: string;
}

export interface ImportOutcome {
  count: number;
  skippedDuplicates: number;
  unknownSkus: string[];
  note: string;
}

function num(v: string | undefined): number {
  const n = Number(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rows are grouped by their invoice column into whole orders; without one, the
 * entire file is read as a single order. Every SKU has to exist in the
 * catalogue — an unknown code is skipped and reported rather than quietly
 * creating a line nobody can pick.
 *
 * `admin` is service-role, because order lines carry a cost snapshot taken
 * from products.cost, which the importing session cannot read (same reason
 * /api/orders/create is service-role). The caller's role is checked before
 * this is ever reached.
 *
 * Orders arrive as `pending`, so a manager still reviews every one before it
 * reaches the warehouse, and no invoice number is issued here.
 */
export async function importOrders(
  admin: SupabaseClient,
  rows: ImportRow[],
  callerId: string
): Promise<ImportOutcome> {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new JobInputError("That file had no rows to import.");
  }

  // ---- Resolve the catalogue and the customers ----
  // PostgREST types a select() as a union of the columns asked for, which is
  // no use for building a lookup, so each result is named once here.
  type ProductLite = {
    id: string;
    sku: string;
    description: string | null;
    price: number;
    cost: number | null;
  };
  type CustomerLite = { id: string; code: string; name: string };
  type UserLite = { id: string; full_name: string; username: string };

  // Every product, a page at a time: one request stops at 1,000 rows without
  // saying so (lib/paging.ts), and with 1,624 products the SKUs past that
  // were reported as unknown and their lines left out of the order.
  const productRows = await fetchAllPages<ProductLite>((from, to) =>
    admin.from("products").select("id, sku, description, price, cost").order("id").range(from, to)
  );
  const bySku = new Map(productRows.map((p) => [p.sku.trim().toLowerCase(), p] as const));

  const { data: customers } = await admin.from("customers").select("id, code, name").eq("is_active", true);
  const customerRows = (customers ?? []) as unknown as CustomerLite[];
  const byCode = new Map(customerRows.map((c) => [c.code.trim().toLowerCase(), c] as const));
  const byName = new Map(customerRows.map((c) => [c.name.trim().toLowerCase(), c] as const));

  const { data: salesmen } = await admin.from("users").select("id, full_name, username").eq("is_active", true);
  const salesmanRows = (salesmen ?? []) as unknown as UserLite[];
  const salesmanByName = new Map(
    salesmanRows.flatMap((u) => [
      [u.full_name.trim().toLowerCase(), u.id] as const,
      [u.username.trim().toLowerCase(), u.id] as const,
    ])
  );

  // ---- Group rows into orders ----
  const groups = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const key = (r.invoice ?? "").trim() || "__single__";
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }

  // Anything already waiting for review with the same customer and the same
  // items is the same order — re-running an import must not double it up.
  const { data: pending } = await admin
    .from("orders")
    .select("id, customer_id, new_customer_note")
    .eq("status", "pending");
  const pendingIds = (pending ?? []).map((o: { id: string }) => o.id);
  const existingFingerprints = new Set<string>();
  if (pendingIds.length) {
    const { data: pendingItems } = await admin
      .from("order_items")
      .select("order_id, product_id, ordered_qty")
      .in("order_id", pendingIds);
    const linesByOrder = new Map<string, string[]>();
    for (const it of (pendingItems ?? []) as {
      order_id: string;
      product_id: string;
      ordered_qty: number;
    }[]) {
      const list = linesByOrder.get(it.order_id) ?? [];
      list.push(`${it.product_id}:${it.ordered_qty}`);
      linesByOrder.set(it.order_id, list);
    }
    for (const o of (pending ?? []) as {
      id: string;
      customer_id: string | null;
      new_customer_note: string | null;
    }[]) {
      const lines = (linesByOrder.get(o.id) ?? []).sort();
      if (lines.length === 0) continue;
      existingFingerprints.add(`${o.customer_id ?? o.new_customer_note ?? ""}|${lines.join(",")}`);
    }
  }

  const unknownSkus = new Set<string>();
  const created: string[] = [];
  let skippedDuplicates = 0;

  for (const [key, groupRows] of groups) {
    // Merge repeated SKUs inside one order rather than creating two lines.
    const lines = new Map<
      string,
      { productId: string; sku: string; description: string; qty: number; price: number; cost: number | null }
    >();
    let customerId: string | null = null;
    let customerNote: string | null = null;
    let salesmanId: string | null = null;

    for (const r of groupRows) {
      const rawCustomer = (r.customer ?? "").trim();
      if (rawCustomer && !customerId && !customerNote) {
        const match = byCode.get(rawCustomer.toLowerCase()) ?? byName.get(rawCustomer.toLowerCase());
        if (match) customerId = match.id;
        else customerNote = rawCustomer;
      }
      const rawSalesman = (r.salesman ?? "").trim();
      if (rawSalesman && !salesmanId) salesmanId = salesmanByName.get(rawSalesman.toLowerCase()) ?? null;

      const rawSku = (r.sku ?? "").trim();
      if (!rawSku) continue;
      const product = bySku.get(rawSku.toLowerCase());
      if (!product) {
        unknownSkus.add(rawSku);
        continue;
      }
      const qty = Math.max(1, Math.round(num(r.qty) || 1));
      const stated = num(r.price);
      const existing = lines.get(product.id);
      if (existing) {
        existing.qty += qty;
      } else {
        lines.set(product.id, {
          productId: product.id,
          sku: product.sku,
          description: product.description ?? "",
          qty,
          // A price in the file is what was agreed; otherwise the catalogue.
          price: stated > 0 ? stated : product.price,
          cost: product.cost ?? null,
        });
      }
    }

    if (lines.size === 0) continue;
    if (!customerId && !customerNote) continue;

    const fingerprint = `${customerId ?? customerNote ?? ""}|${[...lines.values()]
      .map((l) => `${l.productId}:${l.qty}`)
      .sort()
      .join(",")}`;
    if (existingFingerprints.has(fingerprint)) {
      skippedDuplicates += 1;
      continue;
    }

    // The first row of the order that says anything wins; the rest of the
    // order's rows usually leave these cells blank.
    const poNumber = groupRows.map((r) => (r.po_number ?? "").trim()).find(Boolean) ?? null;
    const sheetNote = groupRows.map((r) => (r.note ?? "").trim()).find(Boolean) ?? null;
    const importedTag = key === "__single__" ? "Imported" : `Imported (${key})`;

    const { data: order, error: orderErr } = await admin
      .from("orders")
      .insert({
        customer_id: customerId,
        new_customer_note: customerNote,
        salesman_id: salesmanId ?? callerId,
        status: "pending",
        po_number: poNumber,
        // Says where it came from, so a manager reviewing it knows it was
        // not typed in by a salesman on the road.
        manager_note: sheetNote ? `${importedTag} — ${sheetNote}` : importedTag,
      })
      .select("id")
      .single();
    if (orderErr) throw new JobInputError(orderErr.message);

    const { error: itemsErr } = await admin.from("order_items").insert(
      [...lines.values()].map((l) => ({
        order_id: order.id,
        product_id: l.productId,
        sku: l.sku,
        description: l.description,
        unit_price: l.price,
        unit_cost: l.cost,
        ordered_qty: l.qty,
      }))
    );
    if (itemsErr) throw new JobInputError(itemsErr.message);

    existingFingerprints.add(fingerprint);
    created.push(order.id as string);
  }

  if (created.length === 0) {
    throw new JobInputError(
      unknownSkus.size > 0
        ? `No orders created. These codes aren't in the catalogue: ${[...unknownSkus].slice(0, 8).join(", ")}`
        : skippedDuplicates > 0
        ? "Every order in that file has already been imported."
        : "No orders could be read from that file."
    );
  }

  const notes: string[] = [];
  if (skippedDuplicates > 0) {
    notes.push(
      `${skippedDuplicates} order${skippedDuplicates === 1 ? " was" : "s were"} already imported and skipped.`
    );
  }
  if (unknownSkus.size > 0) {
    notes.push(`Codes not in the catalogue were left out: ${[...unknownSkus].slice(0, 8).join(", ")}.`);
  }

  return {
    count: created.length,
    skippedDuplicates,
    unknownSkus: [...unknownSkus],
    note: notes.join(" "),
  };
}

// ---------------------------------------------------------------------------
// scan.order — a photo of a written order, turned into order lines
// ---------------------------------------------------------------------------

export interface ScannedOrderLine {
  productId: string | null;
  sku: string;
  description: string;
  quantity: number;
  price: number;
  scannedPrice: number | null;
  matched: boolean;
  scannedAs: string;
}

/**
 * The catalogue is read with the non-manager column set, so no cost price is
 * in scope on this path whoever is scanning.
 */
export async function scanOrderLines(
  admin: SupabaseClient,
  base64: string,
  mime: string
): Promise<{ customer: string | null; lines: ScannedOrderLine[] }> {
  const products = await fetchProductsServer(admin, { isManager: false, activeOnly: true });
  const scanned = await scanOrderImage(
    base64,
    mime,
    products.map((p) => ({ sku: p.sku, name: p.name }))
  );

  // Match each scanned line to a real product: the code first, then the
  // barcode, then the description. A line that matches nothing is still
  // returned, so the person can see what was read and fix it rather than
  // wondering why it vanished.
  const bySku = new Map(products.map((p) => [p.sku.toLowerCase(), p]));
  const byBarcode = new Map(
    products.filter((p) => p.barcode).map((p) => [String(p.barcode).toLowerCase(), p])
  );

  const lines = scanned.lines.map((line) => {
    const code = line.articleNum.toLowerCase();
    let match = bySku.get(code) ?? byBarcode.get(code);
    if (!match && line.description) {
      const d = line.description.toLowerCase();
      match =
        products.find((p) => p.name.toLowerCase() === d) ??
        products.find((p) => p.name.toLowerCase().includes(d) || d.includes(p.name.toLowerCase()));
    }
    return {
      productId: match?.id ?? null,
      sku: match?.sku ?? line.articleNum,
      description: match?.name ?? line.description,
      quantity: line.quantity,
      // What to show in the review table.
      price: line.price ?? match?.price ?? 0,
      // Kept separate: a price actually written on the paper is what was
      // agreed with the customer and should override the remembered one,
      // whereas a price we filled in from the catalogue should not.
      scannedPrice: line.price,
      matched: !!match,
      scannedAs: line.articleNum || line.description,
    };
  });

  return { customer: scanned.customer, lines };
}

// ---------------------------------------------------------------------------
// scan.articles — a supplier invoice, turned into products (the reading half)
// ---------------------------------------------------------------------------

export async function existingProductSkus(admin: SupabaseClient): Promise<Set<string>> {
  const { data } = await admin.from("products").select("sku");
  return new Set((data ?? []).map((p: { sku: string }) => p.sku.toLowerCase()));
}

/**
 * Only the reading half is queued. Saving the reviewed rows is one insert of
 * what the manager approved and costs no AI request, so it stays where it is.
 */
export async function scanArticlesPreview(
  admin: SupabaseClient,
  base64: string,
  mime: string
): Promise<{ articles: ScannedArticle[]; duplicates: string[] }> {
  const parsed = await scanArticlesDoc(base64, mime);
  if (parsed.length === 0) {
    throw new JobInputError("No product rows were found in that document.");
  }
  const existing = await existingProductSkus(admin);
  return {
    articles: parsed.filter((a) => !existing.has(a.sku.toLowerCase())),
    duplicates: parsed.filter((a) => existing.has(a.sku.toLowerCase())).map((a) => a.sku),
  };
}
