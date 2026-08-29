// Fallback only — the authoritative rate lives in app_settings.vat_rate
// (read it directly wherever precision matters, e.g. server-side PDF/Excel
// generation). This constant is just for client-side live recalculation
// while editing line items, where fetching settings for every keystroke
// isn't worth it.
export const FALLBACK_VAT_RATE = 0.05;

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

export function lineTotal(item: Priceable): number {
  return item.unit_price * effectiveQty(item);
}

export function subtotal(items: Priceable[]): number {
  return items.reduce((sum, it) => sum + lineTotal(it), 0);
}

export function vat(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return subtotal(items) * rate;
}

export function total(items: Priceable[], rate = FALLBACK_VAT_RATE): number {
  return subtotal(items) * (1 + rate);
}

// customer_discounts is one row per customer (percent or flat amount),
// applied across all their line items — takes a back seat to a specific
// per-product sticky price (customer_prices), which is more authoritative.
export function applyDiscount(
  price: number,
  discount: { discount_type: "percent" | "amount"; discount_value: number } | null
): number {
  if (!discount) return price;
  const discounted =
    discount.discount_type === "percent"
      ? price * (1 - discount.discount_value / 100)
      : price - discount.discount_value;
  return Math.max(0, discounted);
}

export interface Costable {
  unit_cost: number | null;
}

export function grossProfit(items: (Priceable & Costable)[]): number {
  const cost = items.reduce(
    (sum, it) => sum + (it.unit_cost ?? 0) * effectiveQty(it),
    0
  );
  return subtotal(items) - cost;
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
