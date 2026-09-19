import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidateAging, fetchOutstandingInvoices } from "@/lib/queries/aging";
import { allocateFifo, settledNow, money } from "@/lib/money";
import { invalidateOrderFacts } from "@/lib/queries/dashboard";
import type { Payment, Customer, PaymentExtensionRequest, AppUser, Order } from "@/lib/types/db";
import { t } from "@/lib/i18n";

export interface PaymentRow extends Payment {
  customer: Pick<Customer, "id" | "name" | "code"> | null;
  collector: Pick<AppUser, "id" | "full_name"> | null;
}

const BASE_SELECT =
  "id, customer_id, collector_id, amount, status, cheque_number, cheque_bank, cheque_date, cheque_status, cheque_photo_ref, notes, created_at, updated_at";
// discount_amount arrives with scratchpad/RUN-ME-25. PostgREST refuses a whole
// request over one unknown column, so the list asks for it, and asks again
// without it on a database that has not had the file run.
const SELECT = `${BASE_SELECT}, discount_amount`;

type PaymentQuery = PromiseLike<{ data: unknown; error: unknown }>;
async function selectPayments(build: (columns: string) => PaymentQuery): Promise<Payment[]> {
  let { data, error } = await build(SELECT);
  if (error) ({ data, error } = await build(BASE_SELECT));
  if (error) throw error;
  return ((data as Payment[]) ?? []).map((p) => ({ ...p, discount_amount: p.discount_amount ?? 0 }));
}

async function attachPaymentRelations(supabase: SupabaseClient, rows: Payment[]): Promise<PaymentRow[]> {
  if (rows.length === 0) return [];
  const customerIds = [...new Set(rows.map((r) => r.customer_id))];
  const collectorIds = [...new Set(rows.map((r) => r.collector_id))];
  const [{ data: customers }, { data: collectors }] = await Promise.all([
    supabase.from("customers").select("id, name, code").in("id", customerIds),
    supabase.from("users").select("id, full_name").in("id", collectorIds),
  ]);
  const custById = new Map((customers ?? []).map((c) => [c.id, c]));
  const collById = new Map((collectors ?? []).map((c) => [c.id, c]));

  return rows.map((r) => ({
    ...r,
    customer: custById.get(r.customer_id) ?? null,
    collector: collById.get(r.collector_id) ?? null,
  }));
}

export async function fetchPayments(
  supabase: SupabaseClient,
  opts: { status?: "pending" | "confirmed"; collectedBy?: string } = {}
): Promise<PaymentRow[]> {
  const rows = await selectPayments((columns) => {
    let q = supabase.from("payments").select(columns).order("created_at", { ascending: false });
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
    return q;
  });
  return attachPaymentRelations(supabase, rows);
}

export interface PaymentCursor {
  createdAt: string;
  id: string;
}

export interface PaymentPage {
  rows: PaymentRow[];
  nextCursor: PaymentCursor | null;
}

// Real keyset pagination (§0.4/§0.7 — the v1 Sheets bug was exactly "load
// everything, get slow under load") rather than a client-side slice of one
// big fetch. (created_at, id) as the cursor keeps rows stable across pages
// even when several payments share the same created_at timestamp.
export async function fetchPaymentsPage(
  supabase: SupabaseClient,
  opts: {
    status?: "pending" | "confirmed";
    collectedBy?: string;
    pageSize?: number;
    cursor?: PaymentCursor | null;
  } = {}
): Promise<PaymentPage> {
  const pageSize = opts.pageSize ?? 25;
  const rows = await selectPayments((columns) => {
    let q = supabase
      .from("payments")
      .select(columns)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(pageSize + 1);
    if (opts.status) q = q.eq("status", opts.status);
    if (opts.collectedBy) q = q.eq("collector_id", opts.collectedBy);
    if (opts.cursor) {
      q = q.or(
        `created_at.lt.${opts.cursor.createdAt},and(created_at.eq.${opts.cursor.createdAt},id.lt.${opts.cursor.id})`
      );
    }
    return q;
  });
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const nextCursor = hasMore
    ? { createdAt: pageRows[pageRows.length - 1].created_at, id: pageRows[pageRows.length - 1].id }
    : null;
  return { rows: await attachPaymentRelations(supabase, pageRows), nextCursor };
}

export async function createPayment(
  supabase: SupabaseClient,
  input: {
    customer_id: string;
    collected_by: string;
    amount: number;
    // What the manager let go on this collection. The slices below carry
    // amount + discount, so the discount comes off the same invoices the cash
    // does — a discount that lives only in the notes settles nothing.
    discount_amount?: number;
    bank?: string | null;
    cheque_number?: string | null;
    cheque_date?: string | null;
    cheque_photo_ref?: string | null;
    payer_details?: string | null;
    notes?: string | null;
    // payment_orders.allocated_amount is NOT NULL (a payment can span
    // multiple orders, §6) — the caller works out how much of the payment
    // applies to each selected order since only it has the per-invoice
    // balances to split against.
    allocations: { orderId: string; amount: number }[];
  }
): Promise<string> {
  const isCheque = !!(input.cheque_number || input.cheque_date || input.bank);
  const row = {
    customer_id: input.customer_id,
    collector_id: input.collected_by,
    amount: input.amount,
    status: "pending",
    cheque_number: input.cheque_number || null,
    cheque_bank: input.bank || null,
    cheque_date: input.cheque_date || null,
    cheque_status: isCheque ? "pending" : null,
    cheque_photo_ref: input.cheque_photo_ref || null,
    notes: input.notes || null,
  };
  // payer_details may not exist until
  // scratchpad/zones-and-payer-details-migration.sql is run — retried
  // without it rather than failing the whole payment. Cast to `any` since
  // the generated DB types don't know about this optional column yet.
  // discount_amount (RUN-ME-25) is optional in the same way. Tried richest
  // first; each retry drops one column the database may not have yet.
  const discount = money(input.discount_amount ?? 0);
  const extras: Record<string, unknown>[] = [];
  const withPayer = input.payer_details ? { payer_details: input.payer_details } : {};
  if (discount > 0) extras.push({ ...withPayer, discount_amount: discount });
  if (input.payer_details) extras.push(withPayer);
  extras.push({});
  let data: { id: string } | null = null;
  let error: unknown = null;
  for (const extra of extras) {
    ({ data, error } = await supabase.from("payments").insert({ ...row, ...extra } as never).select("id").single());
    if (!error) break;
  }
  if (error || !data) throw error ?? new Error(t("payments.failedToCreatePayment"));

  if (input.allocations.length) {
    const { error: linkErr } = await supabase.from("payment_orders").insert(
      input.allocations.map((a) => ({
        payment_id: data!.id,
        order_id: a.orderId,
        allocated_amount: a.amount,
      }))
    );
    if (linkErr) throw linkErr;
  }
  balancesChanged();
  return data.id as string;
}

// §Customers: "bank name and customer details should be saved/remembered
// for next time" — the most recent cheque this customer paid with, used to
// pre-fill the Log Payment form so the collector isn't retyping it. Returns
// nulls (not an error) if the customer has never paid by cheque, or if the
// payer_details column doesn't exist yet.
export async function fetchLastChequeDetails(
  supabase: SupabaseClient,
  customerId: string
): Promise<{ bank: string | null; payerDetails: string | null }> {
  let { data, error } = await supabase
    .from("payments")
    .select("cheque_bank, payer_details")
    .eq("customer_id", customerId)
    .not("cheque_bank", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    // payer_details may not exist yet — fall back to just the bank name.
    const retry = await supabase
      .from("payments")
      .select("cheque_bank")
      .eq("customer_id", customerId)
      .not("cheque_bank", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    data = retry.data as typeof data;
    error = retry.error;
  }
  if (error || !data) return { bank: null, payerDetails: null };
  return { bank: data.cheque_bank ?? null, payerDetails: (data as { payer_details?: string | null }).payer_details ?? null };
}

// Edit-after-logging (§Payments: "everything can be edited by the user who
// sends the payment afterwards, but the manager is notified about the
// changes"). Caller is responsible for the permission check (collector or
// Manager only) and for notifying managers when a non-manager edits — see
// PaymentsView's EditPaymentSheet, which mirrors the notify() pattern
// already used for order edit-requests.
export async function updatePayment(
  supabase: SupabaseClient,
  id: string,
  patch: {
    amount: number;
    discount_amount?: number;
    // Manager/admin only, and only when they changed it — a confirmed payment
    // can be put back to pending to be corrected.
    status?: "pending" | "confirmed";
    bank?: string | null;
    cheque_number?: string | null;
    cheque_date?: string | null;
    notes?: string | null;
  }
) {
  const isCheque = !!(patch.cheque_number || patch.cheque_date || patch.bank);
  const core: Record<string, unknown> = {
    ...(patch.status ? { status: patch.status } : {}),
    amount: money(patch.amount),
    cheque_number: patch.cheque_number || null,
    cheque_bank: patch.bank || null,
    cheque_date: patch.cheque_date || null,
    notes: patch.notes || null,
  };
  // A payment that stops being a cheque loses its cheque status; one that
  // stays a cheque keeps whatever status it had.
  if (!isCheque) core.cheque_status = null;

  const discount = patch.discount_amount === undefined ? undefined : money(patch.discount_amount);
  let { error } = await supabase
    .from("payments")
    .update(discount === undefined ? core : { ...core, discount_amount: discount })
    .eq("id", id);
  // No discount column yet (RUN-ME-25 not run): save the rest rather than
  // refusing the whole edit.
  if (error && discount !== undefined) ({ error } = await supabase.from("payments").update(core).eq("id", id));
  if (error) throw error;

  await reallocatePayment(supabase, id, settledNow(patch.amount, discount ?? 0));
  balancesChanged();
}

/**
 * Re-cut a payment's per-invoice slices after its amount or discount changed.
 *
 * Only the slices decide what an invoice owes, so an edit that changed
 * payments.amount and left them alone changed nothing anybody ages against —
 * which is what editing a payment did until 2026-09-18.
 *
 * The invoices the payment was already against stay first in line (they are
 * the ones the collector ticked), oldest first, then the customer's other
 * outstanding invoices. Each invoice's room is what it owes WITHOUT this
 * payment, so the payment's own old slices do not crowd out its new ones.
 */
export async function reallocatePayment(supabase: SupabaseClient, paymentId: string, settled: number) {
  const { data: payment, error: payErr } = await supabase
    .from("payments")
    .select("id, customer_id, status")
    .eq("id", paymentId)
    .maybeSingle();
  if (payErr) throw payErr;
  if (!payment) return;

  const { data: oldLinks, error: linkErr } = await supabase
    .from("payment_orders")
    .select("order_id, allocated_amount")
    .eq("payment_id", paymentId);
  if (linkErr) throw linkErr;
  const ownSlice = new Map<string, number>();
  for (const l of oldLinks ?? []) ownSlice.set(l.order_id as string, Number(l.allocated_amount) || 0);

  invalidateAging();
  const invoices = await fetchOutstandingInvoices(supabase, payment.customer_id as string, true);
  // Aging only counts confirmed payments, so a confirmed payment's own slices
  // are already inside each balance and have to be handed back first.
  const counted = payment.status === "confirmed";
  const room = invoices.map((inv) => ({
    orderId: inv.orderId,
    invoiceDate: inv.invoiceDate,
    balance: inv.balance + (counted ? ownSlice.get(inv.orderId) ?? 0 : 0),
  }));
  const preferred = room.filter((r) => ownSlice.has(r.orderId));
  const others = room.filter((r) => !ownSlice.has(r.orderId));
  const slices = allocateFifo(settled, preferred, others);

  const { error: delErr } = await supabase.from("payment_orders").delete().eq("payment_id", paymentId);
  if (delErr) throw delErr;
  if (slices.length) {
    const { error: insErr } = await supabase.from("payment_orders").insert(
      slices.map((s) => ({ payment_id: paymentId, order_id: s.orderId, allocated_amount: s.amount }))
    );
    if (insErr) throw insErr;
  }
}

/** What a customer owes has changed — drop the briefly-held copies. */
function balancesChanged() {
  invalidateAging();
  invalidateOrderFacts();
}

export async function confirmPayment(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("payments").update({ status: "confirmed" }).eq("id", id);
  if (error) throw error;
  balancesChanged();
}

export async function setChequeStatus(
  supabase: SupabaseClient,
  id: string,
  status: "pending" | "cleared" | "bounced" | "returned"
) {
  const { error } = await supabase.from("payments").update({ cheque_status: status }).eq("id", id);
  if (error) throw error;
  balancesChanged();
}

export async function requestExtension(
  supabase: SupabaseClient,
  orderId: string,
  requestedBy: string,
  requestedDueDate: string,
  reason: string
) {
  const { error } = await supabase.from("payment_extension_requests").insert({
    order_id: orderId,
    requested_by: requestedBy,
    requested_due_date: requestedDueDate,
    status: "pending",
    reason,
  });
  if (error) throw error;
}

export async function decideExtension(
  supabase: SupabaseClient,
  id: string,
  status: "approved" | "rejected",
  approvedBy: string
) {
  // Read the request first: approving one has to move the order's due date,
  // or the extension is a note in a table nobody ages against — the invoice
  // stays overdue and the salesman is still chased for it.
  const { data: request, error: readErr } = await supabase
    .from("payment_extension_requests")
    .select("order_id, requested_due_date")
    .eq("id", id)
    .maybeSingle();
  if (readErr) throw readErr;

  const { error } = await supabase
    .from("payment_extension_requests")
    .update({ status, approved_by: approvedBy })
    .eq("id", id);
  if (error) throw error;

  if (status === "approved" && request?.order_id && request.requested_due_date) {
    const { error: orderErr } = await supabase
      .from("orders")
      .update({ extended_due_date: request.requested_due_date })
      .eq("id", request.order_id);
    if (orderErr) throw orderErr;
  }
}

export async function addDelayNote(
  supabase: SupabaseClient,
  orderId: string,
  note: string,
  addedBy: string
) {
  const { error } = await supabase
    .from("payment_delay_notes")
    .insert({ order_id: orderId, note, added_by: addedBy });
  if (error) throw error;
}

export interface ExtensionRequestRow extends PaymentExtensionRequest {
  order: Pick<Order, "id" | "invoice_number" | "customer_id"> | null;
  customerName: string | null;
  requester: Pick<AppUser, "id" | "full_name"> | null;
}

// payment_extension_requests is currently missing from the live schema
// (confirmed via PostgREST introspection) — this list drives a whole
// Payments-page section, so a schema-level failure here degrades to "no
// requests" instead of breaking that page.
export async function fetchExtensionRequests(
  supabase: SupabaseClient
): Promise<ExtensionRequestRow[]> {
  const { data, error } = await supabase
    .from("payment_extension_requests")
    .select("id, order_id, requested_by, requested_due_date, status, approved_by, reason, created_at")
    .order("created_at", { ascending: false });
  if (error) return [];
  const rows = (data as PaymentExtensionRequest[]) ?? [];
  if (rows.length === 0) return [];

  const orderIds = [...new Set(rows.map((r) => r.order_id))];
  const requesterIds = [...new Set(rows.map((r) => r.requested_by))];
  const [{ data: orders }, { data: requesters }] = await Promise.all([
    supabase.from("orders").select("id, invoice_number, customer_id").in("id", orderIds),
    supabase.from("users").select("id, full_name").in("id", requesterIds),
  ]);
  const ordersById = new Map((orders ?? []).map((o) => [o.id, o]));
  const requestersById = new Map((requesters ?? []).map((u) => [u.id, u]));

  const customerIds = [...new Set((orders ?? []).map((o) => o.customer_id).filter(Boolean))] as string[];
  const { data: customers } = customerIds.length
    ? await supabase.from("customers").select("id, name").in("id", customerIds)
    : { data: [] as { id: string; name: string }[] };
  const customersById = new Map((customers ?? []).map((c) => [c.id, c]));

  return rows.map((r) => {
    const order = ordersById.get(r.order_id) ?? null;
    return {
      ...r,
      order,
      customerName: order?.customer_id ? customersById.get(order.customer_id)?.name ?? null : null,
      requester: requestersById.get(r.requested_by) ?? null,
    };
  });
}
