// Every new article carries a cost price (owner, 2026-10-03: "Don't allow
// anybody to add articles without cost — managers don't allow, admins
// warning"). Without one, gross profit on every sale of it reads as the whole
// sale price.
//
// A manager is refused. An admin is warned and may go ahead; the route then
// needs to be told the admin saw the warning (`confirmNoCost`). The same goes
// for clearing the cost of an article that has one (owner, same day: "block
// clearing cost"). An article that has no cost yet is edited as before. The
// database holds the same line for the phone, which writes to `products`
// directly (scratchpad/RUN-ME-33-articles-need-a-cost.sql).

import { t } from "@/lib/i18n";

/** True when `cost` is a real cost price: a number above zero. */
export function hasCost(cost: unknown): boolean {
  if (cost === null || cost === undefined || String(cost).trim() === "") return false;
  const n = Number(cost);
  return Number.isFinite(n) && n > 0;
}

/**
 * What a route does with new articles that have no cost.
 *   ok      — every one has a cost, or an admin has already been warned
 *   refuse  — a manager; nothing without a cost is added
 *   confirm — an admin who has not seen the warning yet
 */
export function noCostVerdict(
  role: string,
  missing: number,
  confirmed: boolean
): "ok" | "refuse" | "confirm" {
  if (missing === 0) return "ok";
  if (role !== "admin") return "refuse";
  return confirmed ? "ok" : "confirm";
}

/** The SKUs to name in a message: the first few, then how many more. */
export function listSkus(skus: string[], max = 8): string {
  const shown = skus.slice(0, max).join(", ");
  return skus.length > max ? t("products.skusAndMore", { skus: shown, n: skus.length - max }) : shown;
}
