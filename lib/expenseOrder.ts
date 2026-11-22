// The order the Expense list is drawn in (owner, 2026-11-22: "the expense
// should be sorted properly and not random").
//
// Sorting by date alone left every expense of one day in whatever order the
// database handed them back — and the 1,057 past expenses (RUN-ME-45) are
// each dated the 1st of their month, so a whole month came out shuffled.
// After the chosen key, rows now fall back on category, then description,
// both A–Z, so a month reads as Petrol, Petrol, Petrol, Rent, Salary…, and
// finally on id so the order never changes between loads.
//
// Amount sorts break ties newest first. The iPhone/Mac app sorts the same way
// in ExpenseView.swift (`ExpenseOrder`). Change one, change both.

export type ExpenseSortKey = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";

interface Sortable {
  id: string;
  date: string;
  amount: number;
  category: string | null;
  description: string | null;
}

const text = new Intl.Collator("en", { sensitivity: "base", numeric: true });

function byKind(a: Sortable, b: Sortable): number {
  return (
    text.compare(a.category ?? "", b.category ?? "") ||
    text.compare(a.description ?? "", b.description ?? "") ||
    a.id.localeCompare(b.id)
  );
}

export function compareExpenses(key: ExpenseSortKey): (a: Sortable, b: Sortable) => number {
  switch (key) {
    case "date_desc":
      return (a, b) => b.date.localeCompare(a.date) || byKind(a, b);
    case "date_asc":
      return (a, b) => a.date.localeCompare(b.date) || byKind(a, b);
    case "amount_desc":
      return (a, b) => b.amount - a.amount || b.date.localeCompare(a.date) || byKind(a, b);
    case "amount_asc":
      return (a, b) => a.amount - b.amount || b.date.localeCompare(a.date) || byKind(a, b);
  }
}
