import type { SupabaseClient } from "@supabase/supabase-js";
import { billingDateColumn, billedAtSelect } from "@/lib/billingDate";
import { t } from "@/lib/i18n";
import { money } from "@/lib/money";
import { fetchOutstandingInvoices } from "@/lib/queries/aging";
import { fetchAllForIds, fetchAllPages } from "@/lib/paging";

// Which invoices a statement carries (owner, 2026-09-18).
//   outstanding — only what still has a balance. This is THE statement: what a
//                 customer is sent to be paid from, so it lists what they owe
//                 and nothing else.
//   paid        — only what has been settled in full, for a customer who asks
//                 what they have paid. Downloaded from beside the Paid row.
//   all         — every invoice and every return in date order, as it was
//                 before. Still answered, no longer the default.
// "Settled" is decided by the same aging every screen uses — after confirmed
// payments, discounts and approved returns — so the statement agrees with the
// customer's sheet, where the same invoices sit under the same Paid row.
export type StatementScope = "outstanding" | "paid" | "all";

// Feeds both the Excel (Manager) and PDF (Salesman/Warehouse) Statement of
// Account exports (Order Flow & Additions §2/§12 — matches the attached
// FGT_Statement_of_Account.xlsx exactly): DATE/INV NO/DESCRIPTION/INVOICE
// AMOUNT/VAT/TOTAL PAYABLE/RECEIVED/BALANCE/DAYS, invoices and approved GRV
// credits merged chronologically with a running balance — GRV rows carry
// negative amounts, exactly as the reference shows.
export interface StatementRow {
  date: string;
  invNo: string;
  description: "INVOICE" | "GRV";
  invoiceAmount: number;
  vat: number;
  totalPayable: number;
  received: number;
  balance: number;
  days: number;
}

export interface Statement {
  rows: StatementRow[];
  totals: {
    invoiceAmount: number;
    vat: number;
    totalPayable: number;
    received: number;
    balance: number;
  };
}

/**
 * `customerId` may be one shop or several.
 *
 * Several is how a shop group is statemented: a chain keeps one account with
 * the distributor but trades under a handful of branch codes, so the account
 * they settle is the union of those branches' invoices and credits, merged
 * chronologically into a single running balance. Passing one id is the
 * ordinary single-shop case and behaves exactly as before.
 */
export async function buildStatement(
  supabase: SupabaseClient,
  customerId: string | string[],
  vatRate: number,
  scope: StatementScope = "all"
): Promise<Statement> {
  const customerIds = Array.isArray(customerId) ? customerId : [customerId];
  if (customerIds.length === 0) {
    return { rows: [], totals: { invoiceAmount: 0, vat: 0, totalPayable: 0, received: 0, balance: 0 } };
  }
  // Paged throughout (lib/paging.ts): a chain's statement is years of
  // invoices across several branches, and one request stops at 1,000 rows.
  // The billing date comes through lib/billingDate.ts.
  type OrderRow = {
    id: string;
    invoice_number: number | null;
    subtotal: number | null;
    vat_amount: number | null;
    total: number | null;
    billed_at: string;
  };
  const select: string = `id, invoice_number, subtotal, vat_amount, total, ${billedAtSelect(await billingDateColumn(supabase))}`;
  const orderRows = await fetchAllForIds<OrderRow>(customerIds, (chunk, from, to) =>
    supabase
      .from("orders")
      .select(select)
      .in("customer_id", chunk)
      .eq("status", "delivered")
      .order("id")
      .range(from, to) as never
  );
  const orderIds = orderRows.map((o) => o.id);

  // A failed read of what was received leaves it at nothing received, as it
  // always has here; the scoped statements take their figures from aging
  // below, which does throw.
  const paidByOrder = new Map<string, number>();
  if (orderIds.length) {
    type LinkRow = { payment_id: string; order_id: string; allocated_amount: number | null };
    const links = await fetchAllForIds<LinkRow>(
      orderIds,
      (chunk, from, to) =>
        supabase
          .from("payment_orders")
          .select("payment_id, order_id, allocated_amount")
          .in("order_id", chunk)
          .order("payment_id")
          .order("order_id")
          .range(from, to) as never,
      { keyOf: (l) => `${l.payment_id}|${l.order_id}` }
    ).catch(() => [] as LinkRow[]);
    const paymentIds = [...new Set(links.map((l) => l.payment_id))];
    const confirmedIds = new Set<string>();
    if (paymentIds.length) {
      const payments = await fetchAllForIds<{ id: string }>(paymentIds, (chunk, from, to) =>
        supabase
          .from("payments")
          .select("id, status")
          .in("id", chunk)
          .eq("status", "confirmed")
          .order("id")
          .range(from, to) as never
      ).catch(() => [] as { id: string }[]);
      for (const p of payments) confirmedIds.add(p.id);
    }
    for (const link of links) {
      if (!confirmedIds.has(link.payment_id)) continue;
      paidByOrder.set(link.order_id, (paidByOrder.get(link.order_id) ?? 0) + (link.allocated_amount ?? 0));
    }
  }

  // For a scoped statement the per-invoice position comes from aging, which
  // has already put approved returns against the oldest invoices. The return
  // rows themselves are then left out: their credit is inside "received", and
  // listing them as well would take it off twice.
  const position = new Map<string, { paid: number; balance: number }>();
  if (scope !== "all") {
    const aged =
      customerIds.length <= 3
        ? (await Promise.all(customerIds.map((id) => fetchOutstandingInvoices(supabase, id, true)))).flat()
        : (await fetchOutstandingInvoices(supabase, undefined, true)).filter((i) => customerIds.includes(i.customerId));
    for (const inv of aged) position.set(inv.orderId, { paid: inv.paid, balance: inv.balance });
  }

  // `amount` arrives with scratchpad/RUN-ME-25; asked for, then asked again
  // without it, so a statement still prints on a database that lacks it.
  type GrvRow = { id: string; created_at: string; amount?: number | null };
  const readGrvs = (columns: string) =>
    fetchAllForIds<GrvRow>(customerIds, (chunk, from, to) =>
      supabase
        .from("grv_returns")
        .select(columns)
        .in("customer_id", chunk)
        .eq("status", "approved")
        .order("id")
        .range(from, to) as never
    );
  const grvRows = await readGrvs("id, created_at, amount").catch(() =>
    readGrvs("id, created_at").catch(() => [] as GrvRow[])
  );
  const grvValueById = new Map<string, number>();
  if (grvRows.length) {
    type ItemRow = { id: string; grv_id: string; qty: number; unit_value: number };
    const items = await fetchAllForIds<ItemRow>(
      grvRows.map((g) => g.id),
      (chunk, from, to) =>
        supabase.from("grv_items").select("id, grv_id, qty, unit_value").in("grv_id", chunk).order("id").range(from, to) as never,
      { keyOf: (it) => it.id }
    ).catch(() => [] as ItemRow[]);
    for (const it of items) {
      grvValueById.set(it.grv_id, (grvValueById.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
    }
  }

  type Entry = { date: string; invNo: string; description: "INVOICE" | "GRV"; invoiceAmount: number; vat: number; totalPayable: number; received: number };
  const entries: Entry[] = [];
  for (const o of orderRows) {
    const pos = position.get(o.id);
    if (scope !== "all") {
      const owed = pos ? pos.balance : Math.max(0, (o.total ?? 0) - (paidByOrder.get(o.id) ?? 0));
      const settled = owed <= 0.01;
      if (scope === "outstanding" ? settled : !settled) continue;
    }
    entries.push({
      date: o.billed_at,
      invNo: o.invoice_number != null ? String(o.invoice_number) : t("common.notSet"),
      description: "INVOICE",
      invoiceAmount: o.subtotal ?? 0,
      vat: o.vat_amount ?? 0,
      totalPayable: o.total ?? 0,
      received: money(pos ? pos.paid : paidByOrder.get(o.id) ?? 0),
    });
  }
  for (const g of scope === "all" ? grvRows : []) {
    // grv_items.unit_value is the ex-VAT credit per unit (same convention as
    // a product's price) — VAT on the credit is added the same way it would
    // have been on the original sale, so the running balance nets out
    // correctly against the invoice it's returning stock against.
    //
    // A return that carries an `amount` (one claimed while collecting a
    // payment) is the other way round: the amount is what the customer was
    // credited, VAT included, so it is split rather than grossed up — and the
    // statement comes down by exactly what aging took off.
    const credited = g.amount != null ? money(g.amount) : null;
    const exVat = credited != null ? money(credited / (1 + vatRate)) : grvValueById.get(g.id) ?? 0;
    const vatAmt = credited != null ? money(credited - exVat) : exVat * vatRate;
    entries.push({
      date: g.created_at,
      invNo: "GRV",
      description: "GRV",
      invoiceAmount: -exVat,
      vat: -vatAmt,
      totalPayable: -(exVat + vatAmt),
      received: 0,
    });
  }

  entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const now = Date.now();
  let running = 0;
  const rows: StatementRow[] = entries.map((e) => {
    running += e.totalPayable - e.received;
    const days = Math.max(0, Math.floor((now - new Date(e.date).getTime()) / (24 * 60 * 60 * 1000)));
    return {
      date: e.date,
      invNo: e.invNo,
      description: e.description,
      invoiceAmount: e.invoiceAmount,
      vat: e.vat,
      totalPayable: e.totalPayable,
      received: e.received,
      balance: running,
      days,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      invoiceAmount: acc.invoiceAmount + r.invoiceAmount,
      vat: acc.vat + r.vat,
      totalPayable: acc.totalPayable + r.totalPayable,
      received: acc.received + r.received,
      balance: rows.length ? rows[rows.length - 1].balance : 0,
    }),
    { invoiceAmount: 0, vat: 0, totalPayable: 0, received: 0, balance: 0 }
  );

  return { rows, totals };
}

// ---------------------------------------------------------------------------
// Salesman-wise statement (owner, 2026-09-18)
//
// Everything still owed on the orders ONE salesman took: the list a salesman
// is sent out to collect, and the list a manager holds them to. It is the
// customer statement's "outstanding" scope turned on its side — the same
// invoices and the same balances, gathered by who sold them instead of by who
// bought them.
//
// The balances come from the aging of the WHOLE book, filtered afterwards to
// this salesman's orders. Aging a salesman's orders on their own would put a
// customer's approved goods return against that salesman's invoices even when
// the customer's oldest invoices were sold by somebody else, and the figures
// here would stop agreeing with the customer's own statement.
// ---------------------------------------------------------------------------
export interface SalesmanStatementRow {
  orderId: string;
  date: string;
  invNo: string;
  customerId: string;
  customerCode: string;
  customerName: string;
  totalPayable: number;
  received: number;
  balance: number;
  days: number;
  overdue: boolean;
}

export interface SalesmanStatement {
  rows: SalesmanStatementRow[];
  totals: { totalPayable: number; received: number; balance: number; overdue: number; customers: number };
}

export async function buildSalesmanStatement(supabase: SupabaseClient, salesmanId: string): Promise<SalesmanStatement> {
  // Ordered by id: this loop used to page without an ordering, which lets the
  // database return the same order on two pages and drop another.
  const ids = new Set(
    (
      await fetchAllPages<{ id: string }>((from, to) =>
        supabase.from("orders").select("id").eq("salesman_id", salesmanId).order("id").range(from, to) as never
      )
    ).map((o) => o.id)
  );
  const empty = { rows: [], totals: { totalPayable: 0, received: 0, balance: 0, overdue: 0, customers: 0 } };
  if (ids.size === 0) return empty;

  const owed = (await fetchOutstandingInvoices(supabase)).filter((inv) => ids.has(inv.orderId));
  if (owed.length === 0) return empty;

  const customerIds = [...new Set(owed.map((i) => i.customerId).filter(Boolean))];
  const customers = new Map<string, { code: string; name: string; overdue_threshold_days: number | null }>();
  for (let i = 0; i < customerIds.length; i += 200) {
    const { data } = await supabase
      .from("customers")
      .select("id, code, name, overdue_threshold_days")
      .in("id", customerIds.slice(i, i + 200));
    for (const c of data ?? []) customers.set(c.id as string, c as never);
  }

  const rows: SalesmanStatementRow[] = owed.map((inv) => {
    const c = customers.get(inv.customerId);
    return {
      orderId: inv.orderId,
      date: inv.invoiceDate,
      invNo: inv.invoiceNumber != null ? String(inv.invoiceNumber) : t("common.notSet"),
      customerId: inv.customerId,
      customerCode: c?.code ?? "",
      customerName: c?.name ?? t("common.notSet"),
      totalPayable: money(inv.total),
      received: money(inv.paid),
      balance: money(inv.balance),
      days: inv.daysOutstanding,
      // Overdue against the customer's own threshold, as everywhere else.
      overdue: inv.daysOutstanding > (c?.overdue_threshold_days ?? 90),
    };
  });
  // Customer by customer, oldest invoice first within each — the order a
  // salesman works through it in.
  rows.sort(
    (a, b) => a.customerName.localeCompare(b.customerName) || new Date(a.date).getTime() - new Date(b.date).getTime()
  );

  const sum = (pick: (r: SalesmanStatementRow) => number) => money(rows.reduce((s, r) => s + pick(r), 0));
  return {
    rows,
    totals: {
      totalPayable: sum((r) => r.totalPayable),
      received: sum((r) => r.received),
      balance: sum((r) => r.balance),
      overdue: sum((r) => (r.overdue ? r.balance : 0)),
      customers: new Set(rows.map((r) => r.customerId)).size,
    },
  };
}
