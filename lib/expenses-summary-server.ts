import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExpenseType } from "@/lib/types/db";
import type { ExpenseSummary, ExpenseSummaryRow } from "@/lib/queries/expenses";
import { fetchAllPages } from "@/lib/paging";
import { toFils, toAed } from "@/lib/money";

// The figures in the summary card at the top of Expenses (owner, 2026-10-10:
// a summary like the one on Products, "shows some key information"). Read
// under the admin key for the reason the rest of /api/expenses is — the
// `expenses` policy refuses every signed-in read — and the route checks the
// caller is a manager before this is called.

const BIGGEST = 5;
const TYPES: ExpenseType[] = ["fixed", "variable", "purchase"];

const pad = (n: number) => String(n).padStart(2, "0");

// `expenses.date` is a plain calendar date, so a month is two date keys and
// no clock is involved. `month` is 1-based here.
function monthKeys(year: number, month: number): { first: string; last: string } {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { first: `${year}-${pad(month)}-01`, last: `${year}-${pad(month)}-${pad(days)}` };
}

export async function fetchExpenseSummaryServer(
  admin: SupabaseClient,
  month: { year: number; month: number }
): Promise<ExpenseSummary> {
  const current = monthKeys(month.year, month.month);
  const previous =
    month.month === 1 ? monthKeys(month.year - 1, 12) : monthKeys(month.year, month.month - 1);

  const rows = await fetchAllPages<ExpenseSummaryRow>(
    (lo, hi) =>
      admin
        .from("expenses")
        .select("id, type, category, description, amount, date")
        .gte("date", previous.first)
        .lte("date", current.last)
        .order("id")
        .range(lo, hi) as never,
    { keyOf: (e) => e.id }
  );

  const byType = Object.fromEntries(TYPES.map((type) => [type, { fils: 0, count: 0 }])) as Record<
    ExpenseType,
    { fils: number; count: number }
  >;
  const thisMonth: ExpenseSummaryRow[] = [];
  let fils = 0;
  let lastFils = 0;
  let lastCount = 0;
  for (const e of rows) {
    const amount = toFils(Number(e.amount) || 0);
    if (e.date >= current.first) {
      thisMonth.push(e);
      fils += amount;
      // A type the app does not know still counts toward the month's total.
      const bucket = byType[e.type];
      if (bucket) {
        bucket.fils += amount;
        bucket.count += 1;
      }
    } else {
      lastFils += amount;
      lastCount += 1;
    }
  }

  const top = thisMonth
    .sort((a, b) => Number(b.amount) - Number(a.amount) || b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
    .slice(0, BIGGEST)
    .map((e) => ({ ...e, amount: toAed(toFils(Number(e.amount) || 0)) }));

  return {
    month: {
      total: toAed(fils),
      count: thisMonth.length,
      byType: Object.fromEntries(
        TYPES.map((type) => [type, { total: toAed(byType[type].fils), count: byType[type].count }])
      ) as ExpenseSummary["month"]["byType"],
      top,
    },
    lastMonth: { total: toAed(lastFils), count: lastCount },
  };
}
