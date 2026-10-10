"use client";

import { useEffect, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { formatAed, toAed, toFils } from "@/lib/money";
import { supabaseBrowser } from "@/lib/supabase/client";
import { monthBounds } from "@/lib/queries/dashboard";
import { getOverdueThresholdDays, type InvoiceAging } from "@/lib/queries/aging";
import { fetchCustomerDirectory, type CustomerDirectoryRow } from "@/lib/queries/customers";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import { SummaryTile, SummaryList } from "@/components/ui/SummaryTile";

const COUNT = new Intl.NumberFormat("en-AE");
const count = (n: number) => COUNT.format(n);

const OWES_MOST = 5;

interface Owing {
  customerId: string;
  name: string;
  code: string;
  fils: number;
  oldestDays: number;
}

// The summary card at the top of Customers (owner, 2026-10-10): how many
// customers there are, what they owe, how much of that is overdue, who bought
// this month and who owes the most. Manager-only — the caller renders it for
// a manager.
//
// `invoices` is the ledger the page has already walked for its own Balance
// column (every billed order, settled ones included), so the card costs no
// second pass; null until it arrives. Outstanding and Overdue are worked out
// the way the Dashboard's Remaining and Overdue are, so the two agree:
// Outstanding here is those two added together.
//
// `refreshKey` changes when this page changes a customer (a save, an import,
// a removal).
export default function CustomersSummary({
  invoices,
  ledgerFailed,
  onRetry,
  refreshKey,
}: {
  invoices: InvoiceAging[] | null;
  ledgerFailed: boolean;
  onRetry: () => void;
  refreshKey: number;
}) {
  const [directory, setDirectory] = useState<{ rows: CustomerDirectoryRow[]; defaultDays: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const supabase = supabaseBrowser();
    Promise.all([fetchCustomerDirectory(supabase), getOverdueThresholdDays(supabase)])
      .then(([rows, defaultDays]) => !cancelled && setDirectory({ rows, defaultDays }))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [refreshKey, attempt]);

  const people = useMemo(() => {
    if (!directory) return null;
    const { from, to } = monthBounds();
    const active = directory.rows.filter((c) => c.is_active);
    const added = active.filter((c) => {
      const at = new Date(c.created_at).getTime();
      return at >= from.getTime() && at <= to.getTime();
    });
    return { active: active.length, added: added.length };
  }, [directory]);

  const money = useMemo(() => {
    if (!directory || !invoices) return null;
    const { from, to } = monthBounds();
    const byId = new Map(directory.rows.map((c) => [c.id, c]));
    const owing = new Map<string, Owing>();
    const overdueCustomers = new Set<string>();
    const buyers = new Set<string>();
    let dueFils = 0;
    let overdueFils = 0;
    let invoicesThisMonth = 0;

    for (const inv of invoices) {
      // An order can be billed with no customer on it; its money still counts.
      const customerId = inv.customerId ?? "";
      const billed = new Date(inv.invoiceDate).getTime();
      if (billed >= from.getTime() && billed <= to.getTime()) {
        invoicesThisMonth += 1;
        if (customerId) buyers.add(customerId);
      }
      if (inv.balance <= 0.01) continue;

      const fils = toFils(inv.balance);
      const customer = byId.get(customerId);
      dueFils += fils;
      let row = owing.get(customerId);
      if (!row) {
        row = {
          customerId,
          name: customer?.name ?? t("common.notSet"),
          code: customer?.code ?? "",
          fils: 0,
          oldestDays: 0,
        };
        owing.set(customerId, row);
      }
      row.fils += fils;
      row.oldestDays = Math.max(row.oldestDays, inv.daysOutstanding);

      // Past the customer's own terms, or the business's when they have none.
      // An extended due date has already moved the invoice's day zero.
      if (inv.daysOutstanding > (customer?.overdue_threshold_days ?? directory.defaultDays)) {
        overdueFils += fils;
        if (customerId) overdueCustomers.add(customerId);
      }
    }

    const top = [...owing.values()]
      .sort((a, b) => b.fils - a.fils || a.name.localeCompare(b.name))
      .slice(0, OWES_MOST);
    return {
      dueFils,
      owingCustomers: [...owing.keys()].filter(Boolean).length,
      overdueFils,
      overdueCustomers: overdueCustomers.size,
      buyers: buyers.size,
      invoicesThisMonth,
      top,
    };
  }, [directory, invoices]);

  // A refresh that fails keeps the figures already on screen.
  const nothingToShow = (failed && !directory) || (ledgerFailed && !invoices);
  if (nothingToShow) {
    return (
      <Card className="p-4 mb-4 flex items-center justify-between gap-3 flex-wrap">
        <span className="text-subhead text-secondary">{t("customers.summaryFailed")}</span>
        <Button
          tier="plain"
          onClick={() => {
            if (failed) setAttempt((n) => n + 1);
            if (ledgerFailed) onRetry();
          }}
        >
          {t("common.retry")}
        </Button>
      </Card>
    );
  }

  return (
    <Card className="p-4 mb-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="grid grid-cols-2 gap-3">
          <SummaryTile
            label={t("customers.summaryCustomers")}
            value={people ? count(people.active) : undefined}
            sub={people ? t("customers.summaryNewThisMonth", { n: count(people.added) }) : undefined}
          />
          <SummaryTile
            label={t("customers.summaryOutstanding")}
            value={money ? formatAed(toAed(money.dueFils)) : undefined}
            sub={money ? t("customers.summaryCustomersOwe", { n: count(money.owingCustomers) }) : undefined}
          />
          <SummaryTile
            label={t("customers.summaryOverdue")}
            value={money ? formatAed(toAed(money.overdueFils)) : undefined}
            sub={money ? t("customers.summaryPastTerms", { n: count(money.overdueCustomers) }) : undefined}
          />
          <SummaryTile
            label={t("customers.summaryBoughtThisMonth")}
            value={money ? count(money.buyers) : undefined}
            sub={money ? t("customers.summaryInvoices", { n: count(money.invoicesThisMonth) }) : undefined}
          />
        </div>

        <SummaryList
          title={t("customers.summaryOwesMost")}
          rows={money?.top}
          empty={t("customers.summaryNobodyOwes")}
          keyOf={(row) => row.customerId}
          name={(row) => row.name}
          note={(row) => row.code}
          detail={(row) => t("customers.summaryOldestDays", { n: count(row.oldestDays) })}
          amount={(row) => formatAed(toAed(row.fils))}
        />
      </div>
    </Card>
  );
}
