"use client";

import { useEffect, useState } from "react";
import { t } from "@/lib/i18n";
import { formatAed } from "@/lib/money";
import { currentMonth } from "@/lib/queries/dashboard";
import { fetchExpenseSummary, type ExpenseSummary as Summary } from "@/lib/queries/expenses";
import type { ExpenseType } from "@/lib/types/db";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { SummaryTile, SummaryList } from "@/components/ui/SummaryTile";

const COUNT = new Intl.NumberFormat("en-AE");
const count = (n: number) => COUNT.format(n);

const TYPE_TILES: { type: ExpenseType; label: string }[] = [
  { type: "fixed", label: t("expense.typeFixed") },
  { type: "variable", label: t("expense.typeVariable") },
  { type: "purchase", label: t("expense.typePurchase") },
];
const TYPE_LABEL = Object.fromEntries(TYPE_TILES.map((x) => [x.type, x.label])) as Record<ExpenseType, string>;

// The summary card at the top of Expenses (owner, 2026-10-10): what has been
// spent this month against last, how it splits by type, and the biggest
// entries. Every expense counts — it does not follow the tabs, the type
// filter or the search under it.
//
// `refreshKey` changes when this page changes an expense (a save, an import,
// a delete), so the figures follow the list under them.
export default function ExpenseSummary({ refreshKey }: { refreshKey: number }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    fetchExpenseSummary(currentMonth())
      .then((s) => !cancelled && setSummary(s))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [refreshKey, attempt]);

  // A refresh that fails keeps the figures already on screen.
  if (failed && !summary) {
    return (
      <Card className="p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-subhead text-secondary">{t("expense.summaryFailed")}</span>
        <Button tier="plain" onClick={() => setAttempt((n) => n + 1)}>
          {t("common.retry")}
        </Button>
      </Card>
    );
  }

  const month = summary?.month;

  return (
    <Card className="p-4 mb-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid grid-cols-2 gap-3">
          <SummaryTile
            label={t("expense.summarySpentThisMonth")}
            value={month && formatAed(month.total)}
            sub={summary ? t("expense.summaryLastMonth", { amount: formatAed(summary.lastMonth.total) }) : undefined}
          />
          {TYPE_TILES.map(({ type, label }) => (
            <SummaryTile
              key={type}
              label={label}
              value={month && formatAed(month.byType[type].total)}
              sub={month && t("expense.summaryLogged", { n: count(month.byType[type].count) })}
            />
          ))}
        </div>

        <SummaryList
          title={t("expense.summaryBiggest")}
          rows={month?.top}
          empty={t("expense.summaryNothingLogged")}
          keyOf={(row) => row.id}
          name={(row) => row.description || row.category || t("common.notSet")}
          note={(row) => `${row.description && row.category ? `${row.category} · ` : ""}${TYPE_LABEL[row.type] ?? row.type}`}
          detail={(row) =>
            new Date(`${row.date}T00:00:00`).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
          }
          amount={(row) => formatAed(row.amount)}
        />
      </div>
    </Card>
  );
}
