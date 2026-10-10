import type { SupabaseClient } from "@supabase/supabase-js";
import type { Expense, ExpenseType } from "@/lib/types/db";
import { fetchSellers, type Seller } from "@/lib/queries/sales";
import type { Month } from "@/lib/queries/dashboard";
import { t } from "@/lib/i18n";

// For the Expense page's "Salesman" tab (§Expense: "separate views for
// both salesman and overview expense") and for the Manager's order-detail
// salesman picker. One list, shared with the Sales page — see fetchSellers.
export async function fetchSalesmen(supabase: SupabaseClient): Promise<Seller[]> {
  return fetchSellers(supabase);
}

// Routed through /api/expenses (service-role, Manager-gated) rather than a
// direct anon-key query — see app/api/expenses/route.ts for why.
export async function fetchExpenses(
  _supabase: unknown,
  opts: { type?: ExpenseType; from?: string; to?: string } = {}
): Promise<Expense[]> {
  const params = new URLSearchParams();
  if (opts.type) params.set("type", opts.type);
  const res = await fetch(`/api/expenses?${params.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to load expenses");
  let rows: Expense[] = data.expenses ?? [];
  if (opts.from) rows = rows.filter((e) => e.date >= opts.from!);
  if (opts.to) rows = rows.filter((e) => e.date <= opts.to!);
  return rows;
}

export async function createExpense(_supabase: unknown, input: Partial<Expense>) {
  const res = await fetch("/api/expenses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to log expense");
}

export async function updateExpense(_supabase: unknown, id: string, input: Partial<Expense>) {
  const res = await fetch("/api/expenses", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...input }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to update expense");
}

export async function deleteExpense(_supabase: unknown, id: string) {
  const res = await fetch("/api/expenses", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? "Failed to delete expense");
}

export interface ExpenseSummaryRow {
  id: string;
  type: ExpenseType;
  category: string | null;
  description: string | null;
  amount: number;
  date: string;
}

// The summary card at the top of Expenses. Every expense counts — the card
// does not follow the page's tabs, type filter or search.
export interface ExpenseSummary {
  month: {
    total: number;
    count: number;
    byType: Record<ExpenseType, { total: number; count: number }>;
    top: ExpenseSummaryRow[]; // the biggest single entries
  };
  lastMonth: { total: number; count: number };
}

// `month` is the month where the person is (currentMonth()) — the server
// runs in UTC and is told rather than left to work it out.
export async function fetchExpenseSummary(month: Month): Promise<ExpenseSummary> {
  const key = `${month.year}-${String(month.month + 1).padStart(2, "0")}`;
  const res = await fetch(`/api/expenses/summary?month=${key}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? t("expense.summaryFailed"));
  return data.summary as ExpenseSummary;
}
