import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_OVERDUE_DAYS, fetchOutstandingInvoices } from "@/lib/queries/aging";
import { money } from "@/lib/money";
import { fetchAllForIds } from "@/lib/paging";
import { t } from "@/lib/i18n";

// Route-planning priority list (§Next Updates Planning: "prioritizing
// overdue-payment customers, 'excellent' customers idle 1+ months,
// customers idle 2-3+ months"). "Idle" = days since their last order,
// distinct from the payment-aging "condition" tag used elsewhere.
//
// Collecting money comes first (owner, 2026-09-18): a customer with an overdue
// balance outranks everyone, then a customer who owes anything at all, and
// only then the visits whose purpose is a new order. What a customer owes is
// the same aging every other screen uses — after confirmed payments, discounts
// and approved returns — not the face value of their invoices, which sent
// salesmen to collect from customers who had already paid.
export type PriorityTier = "overdue" | "due" | "excellentIdle" | "idle" | "normal";

export interface RouteStop {
  customerId: string;
  name: string;
  code: string;
  district: string | null;
  address: string | null;
  tier: PriorityTier;
  reason: string;
  daysIdle: number | null;
  overdueAmount: number;
  /** Everything still owed, overdue or not. */
  outstandingAmount: number;
}

const TIER_RANK: Record<PriorityTier, number> = { overdue: 0, due: 1, excellentIdle: 2, idle: 3, normal: 4 };
const TIER_LABEL: Record<PriorityTier, string> = {
  overdue: t("planning.tierOverdue"),
  due: t("planning.tierDue"),
  excellentIdle: t("planning.tierExcellentIdle"),
  idle: t("planning.tierIdle"),
  normal: "",
};

export async function fetchRoutePriorities(
  supabase: SupabaseClient,
  opts: { city?: string; salesmanId?: string } = {}
): Promise<RouteStop[]> {
  let cq = supabase
    .from("customers")
    .select("id, code, name, district, address, salesman_id, overdue_threshold_days")
    .eq("is_active", true);
  if (opts.salesmanId) cq = cq.eq("salesman_id", opts.salesmanId);
  if (opts.city) cq = cq.ilike("district", `%${opts.city}%`);
  const { data: customers, error } = await cq;
  if (error) throw error;
  if (!customers || customers.length === 0) return [];

  const customerIds = customers.map((c) => c.id);

  // Newest first, so the first order met for a customer is their last one.
  // Paged (lib/paging.ts): unpaged, this kept the newest 1,000 orders of the
  // whole book and every customer whose last order was older than those read
  // as never having ordered. A customer sits in exactly one chunk, so "first
  // met" holds across chunks too. A failed read still ranks on money alone.
  type LastOrderRow = { id: string; customer_id: string; created_at: string };
  const [orders, invoices] = await Promise.all([
    fetchAllForIds<LastOrderRow>(
      customerIds,
      (chunk, from, to) =>
        supabase
          .from("orders")
          .select("id, customer_id, created_at")
          .in("customer_id", chunk)
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to) as never,
      { keyOf: (o) => o.id }
    ).catch(() => [] as LastOrderRow[]),
    // One customer: ask for theirs. Otherwise the whole book, which the aging
    // cache is already holding for the Payments and Customers pages.
    fetchOutstandingInvoices(supabase, customerIds.length === 1 ? customerIds[0] : undefined),
  ]);

  const lastOrderByCustomer = new Map<string, string>();
  for (const o of orders) {
    if (!lastOrderByCustomer.has(o.customer_id)) lastOrderByCustomer.set(o.customer_id, o.created_at);
  }

  const now = Date.now();
  const thresholdByCustomer = new Map(
    customers.map((c) => [c.id as string, (c.overdue_threshold_days as number | null) ?? DEFAULT_OVERDUE_DAYS])
  );
  const overdueByCustomer = new Map<string, number>();
  const outstandingByCustomer = new Map<string, number>();
  for (const inv of invoices) {
    const threshold = thresholdByCustomer.get(inv.customerId);
    if (threshold === undefined) continue; // not one of the customers on this list
    outstandingByCustomer.set(inv.customerId, (outstandingByCustomer.get(inv.customerId) ?? 0) + inv.balance);
    if (inv.daysOutstanding > threshold) {
      overdueByCustomer.set(inv.customerId, (overdueByCustomer.get(inv.customerId) ?? 0) + inv.balance);
    }
  }

  const stops: RouteStop[] = customers.map((c) => {
    const lastOrder = lastOrderByCustomer.get(c.id);
    const daysIdle = lastOrder ? Math.floor((now - new Date(lastOrder).getTime()) / (24 * 60 * 60 * 1000)) : null;
    const overdueAmount = money(overdueByCustomer.get(c.id) ?? 0);
    const outstandingAmount = money(outstandingByCustomer.get(c.id) ?? 0);

    let tier: PriorityTier = "normal";
    if (overdueAmount > 0) tier = "overdue";
    else if (outstandingAmount > 0) tier = "due";
    else if (daysIdle != null && daysIdle >= 60) tier = "idle";
    else if (daysIdle != null && daysIdle >= 30) tier = "excellentIdle";
    else if (daysIdle == null) tier = "idle"; // never ordered — treat as idle, worth a visit

    return {
      customerId: c.id,
      name: c.name,
      code: c.code,
      district: c.district,
      address: c.address,
      tier,
      reason: tier === "overdue" ? t("planning.tierOverdue") : TIER_LABEL[tier],
      daysIdle,
      overdueAmount,
      outstandingAmount,
    };
  });

  stops.sort((a, b) => {
    const rankDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (rankDiff !== 0) return rankDiff;
    if (a.tier === "overdue") return b.overdueAmount - a.overdueAmount;
    if (a.tier === "due") return b.outstandingAmount - a.outstandingAmount;
    return (b.daysIdle ?? 0) - (a.daysIdle ?? 0);
  });

  return stops;
}
