import type { SupabaseClient } from "@supabase/supabase-js";

// Route-planning priority list (§Next Updates Planning: "prioritizing
// overdue-payment customers, 'excellent' customers idle 1+ months,
// customers idle 2-3+ months"). "Idle" = days since their last order,
// distinct from the payment-aging "condition" tag used elsewhere.
export type PriorityTier = "overdue" | "excellentIdle" | "idle" | "normal";

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
}

const TIER_RANK: Record<PriorityTier, number> = { overdue: 0, excellentIdle: 1, idle: 2, normal: 3 };
const TIER_LABEL: Record<PriorityTier, string> = {
  overdue: "Overdue payment",
  excellentIdle: "Excellent, idle 1+ month",
  idle: "Idle 2-3+ months",
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

  const [{ data: orders }, { data: outstanding }] = await Promise.all([
    supabase
      .from("orders")
      .select("customer_id, created_at")
      .in("customer_id", customerIds)
      .order("created_at", { ascending: false }),
    supabase
      .from("orders")
      .select("customer_id, total, status, updated_at")
      .in("customer_id", customerIds)
      .in("status", ["approved", "delivering", "delivered"]),
  ]);

  const lastOrderByCustomer = new Map<string, string>();
  for (const o of orders ?? []) {
    if (!lastOrderByCustomer.has(o.customer_id)) lastOrderByCustomer.set(o.customer_id, o.created_at as string);
  }

  const now = Date.now();
  const overdueByCustomer = new Map<string, number>();
  for (const o of outstanding ?? []) {
    const cust = customers.find((c) => c.id === o.customer_id);
    const threshold = cust?.overdue_threshold_days ?? 90;
    const days = Math.floor((now - new Date(o.updated_at as string).getTime()) / (24 * 60 * 60 * 1000));
    if (days > threshold) {
      overdueByCustomer.set(o.customer_id, (overdueByCustomer.get(o.customer_id) ?? 0) + (Number(o.total) || 0));
    }
  }

  const stops: RouteStop[] = customers.map((c) => {
    const lastOrder = lastOrderByCustomer.get(c.id);
    const daysIdle = lastOrder ? Math.floor((now - new Date(lastOrder).getTime()) / (24 * 60 * 60 * 1000)) : null;
    const overdueAmount = overdueByCustomer.get(c.id) ?? 0;

    let tier: PriorityTier = "normal";
    if (overdueAmount > 0) tier = "overdue";
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
      reason: tier === "overdue" ? `Overdue payment` : TIER_LABEL[tier],
      daysIdle,
      overdueAmount,
    };
  });

  stops.sort((a, b) => {
    const rankDiff = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (rankDiff !== 0) return rankDiff;
    if (a.tier === "overdue") return b.overdueAmount - a.overdueAmount;
    return (b.daysIdle ?? 0) - (a.daysIdle ?? 0);
  });

  return stops;
}
