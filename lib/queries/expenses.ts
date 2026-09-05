import type { SupabaseClient } from "@supabase/supabase-js";
import type { Expense, ExpenseType } from "@/lib/types/db";
import { fetchSellers, type Seller } from "@/lib/queries/sales";

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
