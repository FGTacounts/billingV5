import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchApprovedGrvCreditByCustomer } from "@/lib/queries/grv";
import { fetchCountedStatuses } from "@/lib/reportStage";

// Reconstructs each customer's outstanding balance and aging. `orders`
// stores `total` directly, so this doesn't need to sum order_items itself.
// A confirmed payment reduces the balance of whichever order(s) it's linked
// to via payment_orders. Overdue threshold defaults globally via
// getOverdueThresholdDays() but each customer can override it with
// customers.overdue_threshold_days.

export interface InvoiceAging {
  orderId: string;
  customerId: string;
  invoiceNumber: number | null;
  invoiceDate: string;
  total: number;
  paid: number;
  balance: number;
  daysOutstanding: number;
  extendedDueDate: string | null;
}

// Manager-only (§Next Updates: "extend the payment threshold for a
// specific order too, and not only the customer payment threshold").
export async function extendOrderDueDate(
  supabase: SupabaseClient,
  orderId: string,
  dueDate: string | null
) {
  const { error } = await supabase.from("orders").update({ extended_due_date: dueDate }).eq("id", orderId);
  if (error) throw error;
}

export type Condition = "excellent" | "moderate" | "bad";

export function conditionForDays(days: number): Condition {
  if (days <= 90) return "excellent";
  if (days <= 150) return "moderate";
  return "bad";
}

export const AGING_BUCKETS = [
  { label: "0-90 days", min: 0, max: 90 },
  { label: "90-120 days", min: 91, max: 120 },
  { label: "120-150 days", min: 121, max: 150 },
  { label: "150-180 days", min: 151, max: 180 },
  { label: "180-240 days", min: 181, max: 240 },
  { label: "240-365 days", min: 241, max: 365 },
  { label: "365+ days", min: 366, max: Infinity },
] as const;

// Same burst problem as fetchReportStage — cached with in-flight dedup so
// several concurrent callers share one request instead of each firing their
// own.
let thresholdCache: { days: number; at: number } | null = null;
let thresholdInFlight: Promise<number> | null = null;
const THRESHOLD_TTL_MS = 60_000;

export async function getOverdueThresholdDays(supabase: SupabaseClient): Promise<number> {
  if (thresholdCache && Date.now() - thresholdCache.at < THRESHOLD_TTL_MS) return thresholdCache.days;
  if (thresholdInFlight) return thresholdInFlight;

  thresholdInFlight = (async () => {
    const { data } = await supabase.from("app_settings").select("overdue_threshold_days").limit(1).maybeSingle();
    const days = data?.overdue_threshold_days ?? 90;
    thresholdCache = { days, at: Date.now() };
    return days;
  })().finally(() => {
    thresholdInFlight = null;
  });

  return thresholdInFlight;
}

export async function fetchOutstandingInvoices(
  supabase: SupabaseClient,
  customerId?: string,
  includeSettled = false
): Promise<InvoiceAging[]> {
  // extended_due_date may not exist yet — it's a new column the Manager
  // needs to add themselves (no SQL access from here). Falls back to the
  // column set that's always been there so aging/statements keep working
  // in the meantime; extensions just don't apply until it's added.
  let query = supabase
    .from("orders")
    .select("id, customer_id, invoice_number, total, updated_at, extended_due_date")
    .in("status", await fetchCountedStatuses(supabase));
  if (customerId) query = query.eq("customer_id", customerId);
  let { data: orders, error } = await query;
  if (error) {
    let fallback = supabase
      .from("orders")
      .select("id, customer_id, invoice_number, total, updated_at")
      .in("status", await fetchCountedStatuses(supabase));
    if (customerId) fallback = fallback.eq("customer_id", customerId);
    const retry = await fallback;
    if (retry.error) throw retry.error;
    orders = (retry.data ?? []).map((o) => ({ ...o, extended_due_date: null }));
  }
  const orderRows = orders ?? [];
  if (orderRows.length === 0) return [];
  const orderIds = orderRows.map((o) => o.id);

  const { data: links, error: linksErr } = await supabase
    .from("payment_orders")
    .select("payment_id, order_id, allocated_amount")
    .in("order_id", orderIds);
  if (linksErr) throw linksErr;

  // A payment can span multiple orders (§6) — payment_orders.allocated_amount
  // is the per-order slice, not payments.amount (the whole collection).
  const paymentIds = [...new Set((links ?? []).map((l) => l.payment_id))];
  const confirmedPaymentIds = new Set<string>();
  if (paymentIds.length) {
    const { data: payments, error: payErr } = await supabase
      .from("payments")
      .select("id, status")
      .in("id", paymentIds)
      .eq("status", "confirmed");
    if (payErr) throw payErr;
    for (const p of payments ?? []) confirmedPaymentIds.add(p.id);
  }

  const paidByOrder = new Map<string, number>();
  for (const link of links ?? []) {
    if (!confirmedPaymentIds.has(link.payment_id)) continue;
    paidByOrder.set(link.order_id, (paidByOrder.get(link.order_id) ?? 0) + (link.allocated_amount ?? 0));
  }

  // A per-order due-date extension (§Next Updates: "the manager can extend
  // the payment threshold for a specific order too") shifts the order's
  // effective "day zero" for aging purposes — still in the future = not
  // outstanding yet; past it, days count from there instead of from
  // delivery.
  const now = Date.now();
  const invoices = orderRows.map((o) => {
    const total = o.total ?? 0;
    const paid = paidByOrder.get(o.id) ?? 0;
    const balance = Math.max(0, total - paid);
    const effectiveSinceMs = o.extended_due_date
      ? new Date(o.extended_due_date as string).getTime()
      : new Date(o.updated_at as string).getTime();
    const daysOutstanding = Math.max(0, Math.floor((now - effectiveSinceMs) / (24 * 60 * 60 * 1000)));
    return {
      orderId: o.id,
      customerId: o.customer_id as string,
      invoiceNumber: o.invoice_number,
      invoiceDate: o.updated_at as string,
      total,
      paid,
      balance,
      daysOutstanding,
      extendedDueDate: (o.extended_due_date as string | null) ?? null,
    };
  });

  // An approved GRV is a credit note — apply it against the customer's
  // oldest outstanding invoices first, same as a payment would age off.
  const creditByCustomer = await fetchApprovedGrvCreditByCustomer(
    supabase,
    customerId ? [customerId] : undefined
  );
  if (creditByCustomer.size > 0) {
    const byCustomer = new Map<string, InvoiceAging[]>();
    for (const inv of invoices) {
      if (!byCustomer.has(inv.customerId)) byCustomer.set(inv.customerId, []);
      byCustomer.get(inv.customerId)!.push(inv);
    }
    for (const [custId, custInvoices] of byCustomer) {
      let credit = creditByCustomer.get(custId) ?? 0;
      if (credit <= 0) continue;
      custInvoices.sort((a, b) => new Date(a.invoiceDate).getTime() - new Date(b.invoiceDate).getTime());
      for (const inv of custInvoices) {
        if (credit <= 0) break;
        const applied = Math.min(inv.balance, credit);
        inv.balance -= applied;
        inv.paid += applied;
        credit -= applied;
      }
    }
  }

  return invoices.filter((inv) => includeSettled || inv.balance > 0.01);
}

export async function customerCondition(
  supabase: SupabaseClient,
  customerId: string
): Promise<{ condition: Condition; oldestDays: number; totalDue: number }> {
  const invoices = await fetchOutstandingInvoices(supabase, customerId);
  const oldestDays = invoices.reduce((max, inv) => Math.max(max, inv.daysOutstanding), 0);
  const totalDue = invoices.reduce((sum, inv) => sum + inv.balance, 0);
  return { condition: conditionForDays(oldestDays), oldestDays, totalDue };
}

export interface CustomerAgingSummary {
  customerId: string;
  totalDue: number;
  totalSale: number;
  totalPaid: number;
  oldestDays: number;
  buckets: Record<string, number>;
}

// Pass includeSettled invoices (fetchOutstandingInvoices(..., true)) to get
// totalSale/totalPaid across every delivered order, not just what's still
// outstanding — needed for the Customers list's Sale/Payment columns (§1.6).
export function summarizeByCustomer(
  invoices: InvoiceAging[]
): Map<string, CustomerAgingSummary> {
  const map = new Map<string, CustomerAgingSummary>();
  for (const inv of invoices) {
    let s = map.get(inv.customerId);
    if (!s) {
      s = { customerId: inv.customerId, totalDue: 0, totalSale: 0, totalPaid: 0, oldestDays: 0, buckets: {} };
      map.set(inv.customerId, s);
    }
    s.totalDue += inv.balance;
    s.totalSale += inv.total;
    s.totalPaid += inv.paid;
    s.oldestDays = Math.max(s.oldestDays, inv.daysOutstanding);
    const bucket = AGING_BUCKETS.find(
      (b) => inv.daysOutstanding >= b.min && inv.daysOutstanding <= b.max
    )!;
    s.buckets[bucket.label] = (s.buckets[bucket.label] ?? 0) + inv.balance;
  }
  return map;
}

// Confirmed amount collected against each of the given orders (§Orders
// mockup's Recieved / Balance columns). Same allocation rule as
// fetchOutstandingInvoices: payment_orders.allocated_amount is the
// per-order slice, and only confirmed payments count.
export async function fetchPaidByOrder(
  supabase: SupabaseClient,
  orderIds: string[]
): Promise<Map<string, number>> {
  const paid = new Map<string, number>();
  if (orderIds.length === 0) return paid;

  const { data: links, error } = await supabase
    .from("payment_orders")
    .select("payment_id, order_id, allocated_amount")
    .in("order_id", orderIds);
  if (error) return paid;

  const paymentIds = [...new Set((links ?? []).map((l) => l.payment_id))];
  if (paymentIds.length === 0) return paid;

  const { data: payments } = await supabase
    .from("payments")
    .select("id")
    .in("id", paymentIds)
    .eq("status", "confirmed");
  const confirmed = new Set((payments ?? []).map((p) => p.id));

  for (const link of links ?? []) {
    if (!confirmed.has(link.payment_id)) continue;
    paid.set(link.order_id, (paid.get(link.order_id) ?? 0) + (link.allocated_amount ?? 0));
  }
  return paid;
}
