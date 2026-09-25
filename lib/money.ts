// Money.
//
// WHY THIS FILE IS SHAPED LIKE THIS
//
// The database stores money as Postgres `numeric`, which is exact decimal —
// there is not a float in the schema. JavaScript's `number` is a float
// though, so every figure this app COMPUTES is one, and the arithmetic
// carries the usual error: 0.1 + 0.2 is 0.30000000000000004.
//
// That was landing in the database. A total was computed as a float and
// written straight into an exact column, so an invoice could carry
// 1234.5600000000002 as its real, stored total — not a display artefact, the
// actual figure the customer was billed and the one the VAT return reads.
//
// So every calculation here happens in FILS, as whole numbers — 1 AED is 100
// fils — and only becomes AED at the edge, where it is by construction a
// figure with at most two decimal places. Nothing else in the app should do
// arithmetic on money: call these.
//
// Rounding is half-up on the fil, applied once per line and once on the VAT,
// and the total is the sum of figures already rounded rather than a separate
// multiplication — so the printed lines always add up to the printed total.
// A customer checking the invoice by hand gets the same answer.

// Fallback only — the authoritative rate lives in app_settings.vat_rate
// (read it directly wherever precision matters, e.g. server-side PDF/Excel
// generation). This constant is just for client-side live recalculation
// while editing line items, where fetching settings for every keystroke
// isn't worth it.
export const FALLBACK_VAT_RATE = 0.05;

/** AED as entered or stored → whole fils. */
export function toFils(aed: number): number {
  if (!Number.isFinite(aed)) return 0;
  // The 1e-9 nudge is for the float that arrives already slightly short —
  // 12.345 reaching us as 12.344999999999999 would otherwise round down.
  return Math.round(aed * 100 + (aed >= 0 ? 1e-9 : -1e-9));
}

/** Whole fils → AED, with at most two decimal places. */
export function toAed(fils: number): number {
  return Math.round(fils) / 100;
}

/**
 * The figure to store or send. Anything computed from money passes through
 * here before it is written, so a float artefact can never reach the
 * database.
 */
export function money(aed: number): number {
  return toAed(toFils(aed));
}

export interface Priceable {
  unit_price: number;
  ordered_qty: number;
  picked_qty: number | null;
}

// `orders` stores total/subtotal/vat_amount directly now — prefer reading
// those where the order isn't being actively edited. These compute-from-
// items helpers stay for live editing (e.g. picking screen) where the
// stored aggregate hasn't been recalculated yet. Picked qty wins once it's
// set (approval/export/invoice always uses what was actually picked); falls
// back to ordered qty before picking has happened.
export function effectiveQty(item: Priceable): number {
  return item.picked_qty ?? item.ordered_qty;
}

// ---------------------------------------------------------------- in fils --

/** One line, rounded to the fil — the figure printed against that line. */
export function lineTotalFils(item: Priceable): number {
  return Math.round(toFils(item.unit_price) * effectiveQty(item));
}

/** The sum of the lines as printed, so the invoice adds up. */
export function subtotalFils(items: Priceable[]): number {
  return items.reduce((sum, it) => sum + lineTotalFils(it), 0);
}

export function vatFils(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return Math.round(subtotalFils(items) * rate);
}

export function totalFils(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return subtotalFils(items) + vatFils(items, rate);
}

// ----------------------------------------------------------------- in AED --

export function lineTotal(item: Priceable): number {
  return toAed(lineTotalFils(item));
}

export function subtotal(items: Priceable[]): number {
  return toAed(subtotalFils(items));
}

export function vat(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return toAed(vatFils(items, rate));
}

export function total(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return toAed(totalFils(items, rate));
}

/**
 * VAT and total for a subtotal that is already known — the approval path,
 * which has the subtotal in hand and must not recompute it differently.
 * Returns all three as figures safe to store.
 */
export function billed(subtotalAed: number, rate: number): {
  subtotal: number;
  vatAmount: number;
  total: number;
} {
  const sub = toFils(subtotalAed);
  const tax = Math.round(sub * rate);
  return { subtotal: toAed(sub), vatAmount: toAed(tax), total: toAed(sub + tax) };
}

// A percent-or-amount discount taken off a price. It used to be applied to
// every line automatically from the customer's remembered discount
// (customer_discounts); since 2026-09-21 nothing is discounted unless a
// manager does it on that product or that order, and resolveLinePrice no
// longer calls this.
export function applyDiscount(
  price: number,
  discount: { discount_type: "percent" | "amount"; discount_value: number } | null
): number {
  if (!discount) return price;
  const fils = toFils(price);
  const discounted =
    discount.discount_type === "percent"
      ? Math.round(fils * (1 - discount.discount_value / 100))
      : fils - toFils(discount.discount_value);
  return toAed(Math.max(0, discounted));
}

// What a product costs THIS customer when it goes on an order — the "old
// price". One rule, so a line added at order time, a line added afterwards and
// an imported line can never be priced three ways:
//
//   1. a price written on the document being read (scan / import) — that is
//      what was agreed, on paper (2026-09-04);
//   2. else the price this customer was last billed for this product
//      (customer_prices, written at approval);
//   3. else the list price.
//
// There is no automatic discount (owner, 2026-09-21): a customer's remembered
// whole-order discount used to be rule 3 and came off every later order
// without anybody choosing it. A discount now exists only where a manager
// gives one — Disc % on a product, or the order discount on that order.
// Rule 1 is a manager's too: callers pass `statedPrice` only for a manager,
// and /api/orders/create prices a salesman's lines itself.
//
// A remembered price of zero is NOT a price: it is what a free sample or a
// mis-keyed line leaves behind, and honouring it would bill the next order at
// nothing. It falls through to the rules below it.
// "discount" is still a reason a LINE can carry on screen — the manager's
// order discount sets it — but this function never returns it.
export type PriceReason = "stated" | "sticky_price" | "discount" | null;

export function resolveLinePrice(input: {
  listPrice: number;
  stickyPrice?: number | null;
  statedPrice?: number | null;
}): { price: number; reason: PriceReason } {
  const usable = (n: number | null | undefined): n is number => n != null && Number.isFinite(n) && n > 0;
  if (usable(input.statedPrice)) return { price: money(input.statedPrice), reason: "stated" };
  if (usable(input.stickyPrice)) return { price: money(input.stickyPrice), reason: "sticky_price" };
  return { price: money(input.listPrice), reason: null };
}

// A manager's per-product discount on an order line. order_items has no
// discount column: a line charges its unit_price, and the invoice's Discount
// column is the gap between the product's list price and that. So the
// discount is stored as the price it produces, and read back as the gap.
// Money.swift has the same two functions; change both.

/** List price less N percent — the unit_price to store. */
export function lineDiscountPrice(listPrice: number, percent: number): number {
  const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  return toAed(Math.round(toFils(listPrice) * (1 - pct / 100)));
}

/**
 * The discount a line is carrying, as a percentage of the list price. Zero
 * when the line charges the list price or more — a price raised since the
 * order was written is never shown as a discount.
 */
export function lineDiscountPercent(listPrice: number, unitPrice: number): number {
  const list = toFils(listPrice);
  if (list <= 0) return 0;
  const gap = list - toFils(unitPrice);
  return gap <= 0 ? 0 : Math.round((gap / list) * 10000) / 100;
}

// How a collection is cut into per-invoice slices (payment_orders). Only the
// slices decide what an invoice still owes — payments.amount is never read
// for that — so this one rule is what "the money came off the right orders"
// means. The iPhone app does the same thing in Payments.allocate; if you
// change one, change both and re-run `npm run test:money`.
//
// What is cut is everything that settles debt on the spot: the cash or cheque
// AND any discount the manager gave. A goods return claimed at the door is not
// in it — that is a request, and only comes off once a manager approves it.
export interface Allocatable {
  orderId: string;
  invoiceDate: string;
  balance: number;
}

/** What a collection settles on the spot: cash or cheque, plus any discount. */
export function settledNow(amount: number, discount: number): number {
  return toAed(toFils(Math.max(0, amount)) + toFils(Math.max(0, discount)));
}

/**
 * Oldest first across the invoices the collector ticked, then — if there is
 * still money left — oldest first across the customer's other outstanding
 * invoices. Whatever is left after that stays unallocated on the payment.
 */
export function allocateFifo(
  settled: number,
  preferred: Allocatable[],
  others: Allocatable[]
): { orderId: string; amount: number }[] {
  let remaining = toFils(settled);
  const slices: { orderId: string; amount: number }[] = [];
  const taken = new Set<string>();

  const apply = (list: Allocatable[]) => {
    const oldestFirst = [...list].sort(
      (a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime()
    );
    for (const inv of oldestFirst) {
      if (remaining <= 0) break;
      if (taken.has(inv.orderId)) continue;
      const applied = Math.min(remaining, toFils(inv.balance));
      if (applied <= 0) continue;
      slices.push({ orderId: inv.orderId, amount: toAed(applied) });
      taken.add(inv.orderId);
      remaining -= applied;
    }
  };

  apply(preferred);
  apply(others);
  return slices;
}

export interface Costable {
  unit_cost: number | null;
}

export function grossProfit(items: (Priceable & Costable)[]): number {
  const costFils = items.reduce(
    (sum, it) => sum + Math.round(toFils(it.unit_cost ?? 0) * effectiveQty(it)),
    0
  );
  return toAed(subtotalFils(items) - costFils);
}

const AED_FORMATTER = new Intl.NumberFormat("en-AE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatAed(amount: number): string {
  return `AED ${AED_FORMATTER.format(amount)}`;
}

// Abbreviated form for tight stat tiles — "410k", "1.2m" — as the goal/
// leaderboard mockups draw them. Full precision is always available in the
// tooltip or the row the tile links to.
export function formatCompact(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `${(amount / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return AED_FORMATTER.format(amount);
}
