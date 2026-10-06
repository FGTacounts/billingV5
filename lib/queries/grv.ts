import type { SupabaseClient } from "@supabase/supabase-js";
import { invalidateAging } from "@/lib/queries/aging";
import { invalidateOrderFacts } from "@/lib/queries/dashboard";
import { money } from "@/lib/money";
import { fetchAllForIds, fetchAllPages } from "@/lib/paging";
import { t } from "@/lib/i18n";
import { notifyEveryManager } from "@/lib/queries/orders";
import { fetchApprovalSettings } from "@/lib/approvals";
import type { GrvReturn, GrvItem, Customer } from "@/lib/types/db";

// A goods return (GRV) is a credit note. It reaches the customer's balance
// only once a manager approves it.
//
// There are two ways one is raised:
//   • from Payments → New return, with its products entered up front;
//   • while collecting a payment, as a REQUEST for an amount with no products
//     yet — the collector knows what the customer is claiming, not which
//     cartons came back. A manager opens it, enters the products (so the GRV
//     product report is right), and approves it.
//
// What the customer is credited:
//   • `amount` when the return carries one (VAT included — it is set against
//     invoice totals);
//   • otherwise the value of its lines, which is every return logged before
//     2026-09-18.
// The iPhone app applies the same rule in Aging.swift and Grv.swift.

export interface GrvRow extends GrvReturn {
  customer: Pick<Customer, "id" | "name" | "code"> | null;
  /** Σ qty × unit_value of the lines entered so far. */
  totalValue: number;
  /** What the customer is, or will be, credited. */
  creditValue: number;
  lineCount: number;
}

export interface GrvLine {
  product_id: string;
  qty: number;
  unit_value: number;
}

const BASE_COLUMNS = "id, customer_id, submitted_by, status, approved_by, created_at";
// amount / payment_id / notes arrive with scratchpad/RUN-ME-25. PostgREST
// refuses a whole request over one unknown column, so every read asks for
// them and asks again without them.
const COLUMNS = `${BASE_COLUMNS}, amount, payment_id, notes`;
// grv_number arrives with scratchpad/RUN-ME-34, and is asked for the same way.
const NUMBERED_COLUMNS = `${COLUMNS}, grv_number`;

/** How a GRV is written on a statement and a collection: GRV100. */
export function grvLabel(grvNumber: number | null | undefined): string {
  return grvNumber != null ? `GRV${grvNumber}` : "GRV";
}

/** What one return is worth to the customer. */
export function grvCredit(amount: number | null | undefined, linesValue: number): number {
  return amount != null ? money(amount) : money(linesValue);
}

function returnsChanged() {
  invalidateAging();
  invalidateOrderFacts();
}

interface GrvItemValueRow {
  id: string;
  grv_id: string;
  product_id: string;
  qty: number;
  unit_value: number;
}

// Every line of the given returns. Paged, and the ids chunked (lib/paging.ts):
// one request stops at 1,000 rows without saying so, and a return whose lines
// went missing would be credited at less than it is worth.
function fetchItemsOfGrvs(supabase: SupabaseClient, grvIds: string[]): Promise<GrvItemValueRow[]> {
  return fetchAllForIds<GrvItemValueRow>(
    grvIds,
    (chunk, from, to) =>
      supabase
        .from("grv_items")
        .select("id, grv_id, product_id, qty, unit_value")
        .in("grv_id", chunk)
        .order("id")
        .range(from, to) as never,
    { keyOf: (it) => it.id }
  );
}

export async function fetchGrvs(supabase: SupabaseClient): Promise<GrvRow[]> {
  const read = (columns: string) =>
    fetchAllPages<GrvReturn>(
      (from, to) =>
        supabase
          .from("grv_returns")
          .select(columns)
          .order("created_at", { ascending: false })
          .order("id")
          .range(from, to) as never,
      { keyOf: (r) => r.id }
    );
  const rows = await read(NUMBERED_COLUMNS)
    .catch(() => read(COLUMNS))
    .catch(() => read(BASE_COLUMNS));
  if (rows.length === 0) return [];

  const [{ data: customers }, items] = await Promise.all([
    supabase.from("customers").select("id, name, code").in("id", [...new Set(rows.map((r) => r.customer_id))]),
    // The list has always drawn without line values when they cannot be read.
    fetchItemsOfGrvs(supabase, rows.map((r) => r.id)).catch(() => [] as GrvItemValueRow[]),
  ]);
  const custById = new Map((customers ?? []).map((c) => [c.id, c]));
  const valueByGrv = new Map<string, number>();
  const countByGrv = new Map<string, number>();
  for (const it of items) {
    valueByGrv.set(it.grv_id, (valueByGrv.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
    countByGrv.set(it.grv_id, (countByGrv.get(it.grv_id) ?? 0) + 1);
  }

  return rows.map((r) => {
    const totalValue = money(valueByGrv.get(r.id) ?? 0);
    return {
      ...r,
      customer: custById.get(r.customer_id) ?? null,
      totalValue,
      creditValue: grvCredit(r.amount, totalValue),
      lineCount: countByGrv.get(r.id) ?? 0,
    };
  });
}

export async function fetchGrvItems(
  supabase: SupabaseClient,
  grvId: string
): Promise<(GrvItem & { sku?: string; name?: string })[]> {
  const { data, error } = await supabase
    .from("grv_items")
    .select("id, grv_id, product_id, qty, unit_value")
    .eq("grv_id", grvId);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const productIds = [...new Set(rows.map((r) => r.product_id))];
  // products_safe does not exist in this database, and the name is held in
  // `description`.
  const { data: products } = await supabase.from("products").select("id, sku, description").in("id", productIds);
  const byId = new Map((products ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({ ...r, sku: byId.get(r.product_id)?.sku, name: byId.get(r.product_id)?.description }));
}

export async function createGrv(
  supabase: SupabaseClient,
  customerId: string,
  submittedBy: string,
  items: GrvLine[]
): Promise<string> {
  const { data, error } = await supabase
    .from("grv_returns")
    .insert({ customer_id: customerId, submitted_by: submittedBy, status: "pending" })
    .select("id")
    .single();
  if (error) throw error;
  const { error: itemsErr } = await supabase
    .from("grv_items")
    .insert(items.map((it) => ({ grv_id: data.id, product_id: it.product_id, qty: it.qty, unit_value: it.unit_value })));
  if (itemsErr) throw itemsErr;
  await settleNewReturn(supabase, data.id as string, customerId, submittedBy);
  return data.id as string;
}

/**
 * What happens to a return the moment it exists.
 *
 * Where the admin has switched the goods-return request off
 * (lib/approvals.ts) it is final at once: the database puts the goods back and
 * marks it approved in one step, for the person who raised it and nobody else
 * (scratchpad/RUN-ME-26). Otherwise — or if the database refuses — it stays
 * pending and the managers are told, as before. Returns whether it was
 * finalised, so the screen can say which of the two happened.
 */
async function settleNewReturn(
  supabase: SupabaseClient,
  grvId: string,
  customerId: string,
  submittedBy: string
): Promise<boolean> {
  const approvals = await fetchApprovalSettings(supabase);
  if (!approvals.goodsReturns) {
    const { error } = await supabase.rpc("approve_return_without_approval", { p_grv_id: grvId });
    if (!error) {
      returnsChanged();
      return true;
    }
  }
  await notifyReturnRaised(supabase, customerId, submittedBy);
  return false;
}

// A pending return is off nobody's balance until a manager approves it, so
// the managers hear about it the moment it is raised.
async function notifyReturnRaised(supabase: SupabaseClient, customerId: string, submittedBy: string) {
  try {
    const { data: customer } = await supabase.from("customers").select("name").eq("id", customerId).maybeSingle();
    await notifyEveryManager(
      supabase,
      submittedBy,
      "grv_requested",
      t("inbox.notifGoodsReturn", { customer: customer?.name ?? t("inbox.unknownCustomer") }),
      t("inbox.notifApproveInInbox")
    );
  } catch {
    // Best-effort by design.
  }
}

/**
 * A return claimed while collecting a payment: a pending request for an
 * amount, already carrying the customer, with no products on it yet.
 *
 * Returns null — and raises nothing — when the database has no `amount`
 * column (RUN-ME-25 not run). A request with neither an amount nor a line
 * would be an empty row worth nothing, so the caller falls back to recording
 * the claim in the payment's notes, as both apps did before.
 */
export async function createGrvRequest(
  supabase: SupabaseClient,
  input: { customerId: string; submittedBy: string; amount: number; paymentId?: string | null; notes?: string | null }
): Promise<{ id: string; approved: boolean } | null> {
  const { data, error } = await supabase
    .from("grv_returns")
    .insert({
      customer_id: input.customerId,
      submitted_by: input.submittedBy,
      status: "pending",
      amount: money(input.amount),
      payment_id: input.paymentId ?? null,
      notes: input.notes ?? null,
    })
    .select("id")
    .single();
  if (error) {
    // 42703 / PGRST204: the column is not there yet.
    const code = (error as { code?: string }).code;
    if (code === "42703" || code === "PGRST204") return null;
    throw error;
  }
  const approved = await settleNewReturn(supabase, data.id as string, input.customerId, input.submittedBy);
  return { id: data.id as string, approved };
}

// Sum of approved GRV credit per customer — a credit note that reduces the
// customer's outstanding balance once approved. Consumed by aging.ts /
// dashboard.ts to apply against the customer's oldest invoices first, the
// same order confirmed payments already age off.
//
// Only returns WITHOUT a number. A numbered GRV (approved from 2026-10-06,
// RUN-ME-34) is not spread over the oldest invoices: it stays open until a
// collector ticks it, and then counts through grv_allocations instead.
export async function fetchApprovedGrvCreditByCustomer(
  supabase: SupabaseClient,
  customerIds?: string[]
): Promise<Map<string, number>> {
  type ApprovedRow = { id: string; customer_id: string; amount?: number | null; grv_number?: number | null };
  const page = (columns: string, ids: string[] | null) => (from: number, to: number) => {
    let query = supabase.from("grv_returns").select(columns).eq("status", "approved");
    if (ids) query = query.in("customer_id", ids);
    return query.order("id").range(from, to) as never;
  };
  const read = (columns: string) =>
    customerIds && customerIds.length
      ? fetchAllForIds<ApprovedRow>(customerIds, (chunk, from, to) => page(columns, chunk)(from, to), {
          keyOf: (g) => g.id,
        })
      : fetchAllPages<ApprovedRow>(page(columns, null), { keyOf: (g) => g.id });
  const rows = (
    await read("id, customer_id, amount, grv_number")
      .catch(() => read("id, customer_id, amount"))
      .catch(() => read("id, customer_id"))
  ).filter((g) => g.grv_number == null);
  if (rows.length === 0) return new Map();

  const items = await fetchItemsOfGrvs(supabase, rows.map((g) => g.id));
  const linesValue = new Map<string, number>();
  for (const it of items) {
    linesValue.set(it.grv_id, (linesValue.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
  }

  const creditByCustomer = new Map<string, number>();
  for (const g of rows) {
    const credit = grvCredit(g.amount, linesValue.get(g.id) ?? 0);
    creditByCustomer.set(g.customer_id, (creditByCustomer.get(g.customer_id) ?? 0) + credit);
  }
  return creditByCustomer;
}

export interface GrvAllocationRow {
  grv_id: string;
  order_id: string;
  amount: number;
  payment_id: string | null;
}

/**
 * What numbered GRVs have been used against, by invoice or by GRV. An empty
 * list — not an error — when grv_allocations is not there yet (RUN-ME-34 not
 * run), which is the same as nothing having been ticked.
 */
export async function fetchGrvAllocations(
  supabase: SupabaseClient,
  by: { orderIds?: string[]; grvIds?: string[] }
): Promise<GrvAllocationRow[]> {
  const column = by.orderIds ? "order_id" : "grv_id";
  const ids = by.orderIds ?? by.grvIds ?? [];
  if (ids.length === 0) return [];
  type Row = GrvAllocationRow & { id: string };
  const page = (chunk: string[] | null) => (from: number, to: number) => {
    let query = supabase.from("grv_allocations").select("id, grv_id, order_id, amount, payment_id");
    if (chunk) query = query.in(column, chunk);
    return query.order("id").range(from, to) as never;
  };
  // The whole book's aging names thousands of invoices; the table is small,
  // so past a hundred ids read all of it and match here — as aging does with
  // payment_orders.
  const wanted = new Set(ids);
  const read =
    ids.length > 100
      ? fetchAllPages<Row>(page(null), { keyOf: (r) => r.id }).then((rows) =>
          rows.filter((r) => wanted.has(column === "order_id" ? r.order_id : r.grv_id))
        )
      : fetchAllForIds<Row>(ids, (chunk, from, to) => page(chunk)(from, to), { keyOf: (r) => r.id });
  return read
    .then((rows) => rows.map((r) => ({ ...r, amount: Number(r.amount) || 0 })))
    .catch(() => [] as GrvAllocationRow[]);
}

export interface NumberedGrv {
  id: string;
  customerId: string;
  grvNumber: number;
  /** The day the goods came back. */
  date: string;
  /** What the customer is credited, VAT included where it carries an amount. */
  credit: number;
  /** Used against invoices so far. */
  used: number;
  /** Still to be ticked: shows on the statement and at collection. */
  open: number;
}

/**
 * Every approved, numbered GRV of these customers, with how much of each is
 * still open. Empty until RUN-ME-34 has been run.
 */
export async function fetchNumberedGrvs(supabase: SupabaseClient, customerIds: string[]): Promise<NumberedGrv[]> {
  if (customerIds.length === 0) return [];
  type Row = { id: string; customer_id: string; created_at: string; amount: number | null; grv_number: number | null };
  const rows = await fetchAllForIds<Row>(
    customerIds,
    (chunk, from, to) =>
      supabase
        .from("grv_returns")
        .select("id, customer_id, created_at, amount, grv_number")
        .in("customer_id", chunk)
        .eq("status", "approved")
        .not("grv_number", "is", null)
        .order("id")
        .range(from, to) as never,
    { keyOf: (g) => g.id }
  ).catch(() => [] as Row[]);
  if (rows.length === 0) return [];

  const ids = rows.map((g) => g.id);
  const [items, allocations] = await Promise.all([
    fetchItemsOfGrvs(supabase, ids),
    fetchGrvAllocations(supabase, { grvIds: ids }),
  ]);
  const linesValue = new Map<string, number>();
  for (const it of items) linesValue.set(it.grv_id, (linesValue.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
  const usedBy = new Map<string, number>();
  for (const a of allocations) usedBy.set(a.grv_id, (usedBy.get(a.grv_id) ?? 0) + a.amount);

  return rows
    .map((g) => {
      const credit = grvCredit(g.amount, linesValue.get(g.id) ?? 0);
      const used = money(usedBy.get(g.id) ?? 0);
      return {
        id: g.id,
        customerId: g.customer_id,
        grvNumber: g.grv_number as number,
        date: g.created_at,
        credit,
        used,
        open: money(Math.max(0, credit - used)),
      };
    })
    .sort((a, b) => a.grvNumber - b.grvNumber);
}

/**
 * The GRVs a collector ticked, written against the invoices they were used
 * on. The database refuses a use bigger than what is left on the GRV, or on
 * another customer's invoice (RUN-ME-34).
 */
export async function applyGrvCredits(
  supabase: SupabaseClient,
  uses: { creditId: string; orderId: string; amount: number }[],
  paymentId: string | null
) {
  if (uses.length === 0) return;
  const { error } = await supabase.from("grv_allocations").insert(
    uses.map((u) => ({ grv_id: u.creditId, order_id: u.orderId, amount: money(u.amount), payment_id: paymentId }))
  );
  if (error) throw error;
  returnsChanged();
}

async function moveStock(supabase: SupabaseClient, productId: string, delta: number) {
  if (delta === 0) return;
  const { data: product } = await supabase
    .from("products")
    .select("stock_on_hand")
    .eq("id", productId)
    .maybeSingle();
  if (!product) return;
  await supabase
    .from("products")
    .update({ stock_on_hand: Math.max(0, (product.stock_on_hand ?? 0) + delta) })
    .eq("id", productId);
}

// Approval restores stock_on_hand for every returned line, then folds the
// credited value into the customer's balance (see fetchApprovedGrvCreditByCustomer).
export async function approveGrv(supabase: SupabaseClient, grvId: string, approvedBy: string) {
  // Read the status first: approving twice would put the stock back twice.
  const { data: grv, error: grvErr } = await supabase
    .from("grv_returns")
    .select("status")
    .eq("id", grvId)
    .maybeSingle();
  if (grvErr) throw grvErr;
  if (!grv || grv.status === "approved") return;

  const { data: items, error } = await supabase
    .from("grv_items")
    .select("product_id, qty")
    .eq("grv_id", grvId);
  if (error) throw error;

  for (const it of items ?? []) await moveStock(supabase, it.product_id, it.qty);

  const { error: updErr } = await supabase
    .from("grv_returns")
    .update({ status: "approved", approved_by: approvedBy })
    .eq("id", grvId);
  if (updErr) throw updErr;
  returnsChanged();
}

/**
 * Manager/admin: correct a return after it was entered — its amount, its
 * note and its products — whether it is still pending or already approved.
 *
 * An approved return has already put its goods back on the shelf, so changing
 * its lines moves stock by the difference: three cartons corrected to two
 * takes one back off.
 *
 * Needs the policies in RUN-ME-25; without them the database refuses the line
 * changes and this throws, which the sheet reports.
 */
export async function saveGrv(
  supabase: SupabaseClient,
  grvId: string,
  patch: { amount: number | null; notes: string | null; lines: GrvLine[] }
) {
  const { data: grv, error: grvErr } = await supabase
    .from("grv_returns")
    .select("status")
    .eq("id", grvId)
    .maybeSingle();
  if (grvErr) throw grvErr;
  if (!grv) return;

  const { data: before, error: beforeErr } = await supabase
    .from("grv_items")
    .select("product_id, qty")
    .eq("grv_id", grvId);
  if (beforeErr) throw beforeErr;

  const { error: delErr } = await supabase.from("grv_items").delete().eq("grv_id", grvId);
  if (delErr) throw delErr;
  if (patch.lines.length) {
    const { error: insErr } = await supabase.from("grv_items").insert(
      patch.lines.map((l) => ({ grv_id: grvId, product_id: l.product_id, qty: l.qty, unit_value: money(l.unit_value) }))
    );
    if (insErr) throw insErr;
  }

  const { error: updErr } = await supabase
    .from("grv_returns")
    .update({ amount: patch.amount == null ? null : money(patch.amount), notes: patch.notes })
    .eq("id", grvId);
  // No amount column yet: the lines were still saved, which is what an old
  // return is valued from anyway.
  const code = (updErr as { code?: string } | null)?.code;
  if (updErr && code !== "42703" && code !== "PGRST204") throw updErr;

  if (grv.status === "approved") {
    const delta = new Map<string, number>();
    for (const l of patch.lines) delta.set(l.product_id, (delta.get(l.product_id) ?? 0) + l.qty);
    for (const b of before ?? []) delta.set(b.product_id, (delta.get(b.product_id) ?? 0) - b.qty);
    for (const [productId, d] of delta) await moveStock(supabase, productId, d);
  }
  returnsChanged();
}

/**
 * Manager/admin: remove a return that should never have been raised. Only a
 * pending one — an approved return has moved stock and credited a customer,
 * and the way to undo that is to correct it, not to erase it.
 */
export async function deleteGrv(supabase: SupabaseClient, grvId: string) {
  const { error: itemsErr } = await supabase.from("grv_items").delete().eq("grv_id", grvId);
  if (itemsErr) throw itemsErr;
  const { data, error } = await supabase
    .from("grv_returns")
    .delete()
    .eq("id", grvId)
    .eq("status", "pending")
    .select("id");
  if (error) throw error;
  // RLS refuses a delete silently — zero rows and no error.
  if (!data || data.length === 0) throw new Error("not_deleted");
  returnsChanged();
}

export interface GrvProductRow {
  productId: string;
  sku: string;
  name: string;
  qty: number;
  value: number;
  returns: number;
}

/**
 * Which products came back, and how many — approved returns only, because a
 * pending request is a claim, not goods on the shelf.
 */
export async function fetchGrvProductReport(supabase: SupabaseClient): Promise<GrvProductRow[]> {
  const grvs = await fetchAllPages<{ id: string }>(
    (from, to) => supabase.from("grv_returns").select("id").eq("status", "approved").order("id").range(from, to) as never,
    { keyOf: (g) => g.id }
  );
  const ids = grvs.map((g) => g.id);
  if (ids.length === 0) return [];

  const rows = await fetchItemsOfGrvs(supabase, ids);
  if (rows.length === 0) return [];

  // Chunked for the URL's sake; a product is one row, so a chunk of two
  // hundred ids can never reach the row ceiling.
  type ProductRow = { id: string; sku: string | null; description: string | null };
  const products = await fetchAllForIds<ProductRow>(
    rows.map((r) => r.product_id),
    (chunk, from, to) =>
      supabase.from("products").select("id, sku, description").in("id", chunk).order("id").range(from, to) as never
  ).catch(() => [] as ProductRow[]);
  const byId = new Map(products.map((p) => [p.id, p]));

  const out = new Map<string, GrvProductRow & { seen: Set<string> }>();
  for (const it of rows) {
    const id = it.product_id as string;
    let row = out.get(id);
    if (!row) {
      const p = byId.get(id);
      row = { productId: id, sku: p?.sku ?? "", name: p?.description ?? "", qty: 0, value: 0, returns: 0, seen: new Set() };
      out.set(id, row);
    }
    row.qty += it.qty;
    row.value += it.qty * it.unit_value;
    row.seen.add(it.grv_id as string);
  }
  return [...out.values()]
    .map(({ seen, ...r }) => ({ ...r, value: money(r.value), returns: seen.size }))
    .sort((a, b) => b.qty - a.qty);
}
