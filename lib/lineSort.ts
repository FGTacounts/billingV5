// How an order's lines are listed — on the order screen, while picking, and on
// the invoice PDF and Excel (owner, 2026-09-26): by article number unless the
// viewer picks another sort, and unpicked lines always at the end, whatever
// the sort. One function so the screen and the paper never list them apart.
//
// "arranged" is the order a manager set with the up/down arrows
// (orders.line_order, 2026-09-25), which is the order fetchOrderItems returns.

export type LineSort = "article" | "rack" | "arranged";

export const DEFAULT_LINE_SORT: LineSort = "article";

export const LINE_SORTS: readonly LineSort[] = ["article", "rack", "arranged"];

export function parseLineSort(value: string | null | undefined): LineSort {
  return LINE_SORTS.includes(value as LineSort) ? (value as LineSort) : DEFAULT_LINE_SORT;
}

interface Sortable {
  sku: string | null;
  picked_qty: number | null;
  product?: { rack_location: string | null } | null;
}

/**
 * Not picked: the warehouse has not ticked it, or ticked it at nothing. The
 * same test the Excel's "separate marked" and the phone's picks already use.
 * A short pick is picked — it is on the invoice at what was found.
 */
export function isUnpicked(line: Pick<Sortable, "picked_qty">): boolean {
  return line.picked_qty == null || line.picked_qty <= 0;
}

// "GLT100" before "GLT1000", and "GLT2" before "GLT10".
const bySku = (a: Sortable, b: Sortable) =>
  (a.sku ?? "").localeCompare(b.sku ?? "", undefined, { numeric: true, sensitivity: "base" });

export function sortOrderLines<T extends Sortable>(lines: T[], sort: LineSort = DEFAULT_LINE_SORT): T[] {
  const copy = [...lines];
  if (sort === "article") {
    copy.sort(bySku);
  } else if (sort === "rack") {
    // Lines with no rack after those with one; article number within a rack.
    copy.sort((a, b) => {
      const ra = a.product?.rack_location ?? "";
      const rb = b.product?.rack_location ?? "";
      if (!ra !== !rb) return ra ? -1 : 1;
      return ra.localeCompare(rb, undefined, { numeric: true, sensitivity: "base" }) || bySku(a, b);
    });
  }
  // Stable, so each half keeps the order chosen above.
  return [...copy.filter((l) => !isUnpicked(l)), ...copy.filter(isUnpicked)];
}
