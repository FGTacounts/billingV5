import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function buildStatement(
  supabase: SupabaseClient,
  customerId: string,
  vatRate: number
): Promise<Statement> {
  const { data: orders, error } = await supabase
    .from("orders")
    .select("id, invoice_number, subtotal, vat_amount, total, updated_at")
    .eq("customer_id", customerId)
    .eq("status", "delivered");
  if (error) throw error;
  const orderRows = orders ?? [];
  const orderIds = orderRows.map((o) => o.id);

  const paidByOrder = new Map<string, number>();
  if (orderIds.length) {
    const { data: links } = await supabase
      .from("payment_orders")
      .select("payment_id, order_id, allocated_amount")
      .in("order_id", orderIds);
    const paymentIds = [...new Set((links ?? []).map((l) => l.payment_id))];
    const confirmedIds = new Set<string>();
    if (paymentIds.length) {
      const { data: payments } = await supabase
        .from("payments")
        .select("id, status")
        .in("id", paymentIds)
        .eq("status", "confirmed");
      for (const p of payments ?? []) confirmedIds.add(p.id);
    }
    for (const link of links ?? []) {
      if (!confirmedIds.has(link.payment_id)) continue;
      paidByOrder.set(link.order_id, (paidByOrder.get(link.order_id) ?? 0) + (link.allocated_amount ?? 0));
    }
  }

  const { data: grvs } = await supabase
    .from("grv_returns")
    .select("id, created_at")
    .eq("customer_id", customerId)
    .eq("status", "approved");
  const grvRows = grvs ?? [];
  const grvValueById = new Map<string, number>();
  if (grvRows.length) {
    const { data: items } = await supabase
      .from("grv_items")
      .select("grv_id, qty, unit_value")
      .in("grv_id", grvRows.map((g) => g.id));
    for (const it of items ?? []) {
      grvValueById.set(it.grv_id, (grvValueById.get(it.grv_id) ?? 0) + it.qty * it.unit_value);
    }
  }

  type Entry = { date: string; invNo: string; description: "INVOICE" | "GRV"; invoiceAmount: number; vat: number; totalPayable: number; received: number };
  const entries: Entry[] = [];
  for (const o of orderRows) {
    entries.push({
      date: o.updated_at,
      invNo: o.invoice_number != null ? String(o.invoice_number) : "—",
      description: "INVOICE",
      invoiceAmount: o.subtotal ?? 0,
      vat: o.vat_amount ?? 0,
      totalPayable: o.total ?? 0,
      received: paidByOrder.get(o.id) ?? 0,
    });
  }
  for (const g of grvRows) {
    // grv_items.unit_value is the ex-VAT credit per unit (same convention as
    // a product's price) — VAT on the credit is added the same way it would
    // have been on the original sale, so the running balance nets out
    // correctly against the invoice it's returning stock against.
    const exVat = grvValueById.get(g.id) ?? 0;
    const vatAmt = exVat * vatRate;
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
