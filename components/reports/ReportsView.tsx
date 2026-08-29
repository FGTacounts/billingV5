"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchOutstandingInvoices, summarizeByCustomer, AGING_BUCKETS } from "@/lib/queries/aging";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchBalanceSheet, fetchStockSnapshot, type BalanceSheet, type StockSnapshotRow } from "@/lib/queries/reports";
import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/queries/sales";
import { fetchGrvs, type GrvRow } from "@/lib/queries/grv";
import { fetchPurchases, type PurchaseRow } from "@/lib/queries/purchases";
import { formatAed } from "@/lib/money";
import { SkeletonList } from "@/components/ui/Empty";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";

// §Next Updates Reports: "ability to download each of the reports" — a
// plain client-side CSV export of whatever's on screen, no server round
// trip needed since the report data is already loaded into the browser.
function downloadCsv(filename: string, head: string[], rows: (string | number)[][]) {
  const escape = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [head, ...rows].map((r) => r.map(escape).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const TABS = ["Customer Aging", "Statement Summary", "Sales", "Balance Sheet", "Stock", "Purchases", "GRV"] as const;
type Tab = (typeof TABS)[number];

export default function ReportsView() {
  const [tab, setTab] = useState<Tab>("Customer Aging");

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <h1 className="text-large-title font-bold mb-5">Reports</h1>
      <div className="flex flex-wrap gap-1.5 mb-5">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 rounded-card text-caption font-semibold whitespace-nowrap border ${
              tab === t ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Customer Aging" && <CustomerAgingTab />}
      {tab === "Statement Summary" && <StatementSummaryTab />}
      {tab === "Sales" && <SalesTab />}
      {tab === "Balance Sheet" && <BalanceSheetTab />}
      {tab === "Stock" && <StockTab />}
      {tab === "Purchases" && <PurchasesTab />}
      {tab === "GRV" && <GrvTab />}
    </div>
  );
}

function Table({ head, rows, filename }: { head: string[]; rows: (string | number)[][]; filename: string }) {
  return (
    <div>
      <div className="flex justify-end mb-2">
        <Button tier="plain" onClick={() => downloadCsv(filename, head, rows)} className="flex items-center gap-1.5">
          <Download size={14} /> Download CSV
        </Button>
      </div>
      <div className="bg-surface border border-hairline rounded-card overflow-x-auto">
      <table className="w-full text-subhead">
        <thead>
          <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
            {head.map((h) => (
              <th key={h} className="px-3.5 py-2.5 font-medium whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-hairline last:border-0">
              {r.map((c, j) => (
                <td key={j} className="px-3.5 py-2.5 tabular-nums whitespace-nowrap">{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}

function CustomerAgingTab() {
  const [rows, setRows] = useState<{ name: string; total: number; buckets: Record<string, number> }[] | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = supabaseBrowser();
      const [invoices, customers] = await Promise.all([
        fetchOutstandingInvoices(supabase),
        fetchCustomers(supabase),
      ]);
      const nameById = new Map(customers.map((c) => [c.id, c.name]));
      const summary = summarizeByCustomer(invoices);
      setRows(
        [...summary.values()]
          .map((s) => ({ name: nameById.get(s.customerId) ?? "—", total: s.totalDue, buckets: s.buckets }))
          .sort((a, b) => b.total - a.total)
      );
    })();
  }, []);

  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="customer-aging.csv"
      head={["Customer", "Total due", ...AGING_BUCKETS.map((b) => b.label)]}
      rows={rows.map((r) => [
        r.name,
        formatAed(r.total),
        ...AGING_BUCKETS.map((b) => (r.buckets[b.label] ? formatAed(r.buckets[b.label]) : "-")),
      ])}
    />
  );
}

function StatementSummaryTab() {
  const [rows, setRows] = useState<{ name: string; code: string; district: string; total: number; balance: number }[] | null>(null);

  useEffect(() => {
    (async () => {
      const supabase = supabaseBrowser();
      const [invoices, customers] = await Promise.all([
        fetchOutstandingInvoices(supabase, undefined, true),
        fetchCustomers(supabase),
      ]);
      const byCustomer = new Map<string, { total: number; balance: number }>();
      for (const inv of invoices) {
        const cur = byCustomer.get(inv.customerId) ?? { total: 0, balance: 0 };
        cur.total += inv.total;
        cur.balance += inv.balance;
        byCustomer.set(inv.customerId, cur);
      }
      setRows(
        customers
          .filter((c) => byCustomer.has(c.id))
          .map((c) => ({ name: c.name, code: c.code, district: c.district ?? "", ...byCustomer.get(c.id)! }))
          .sort((a, b) => b.balance - a.balance)
      );
    })();
  }, []);

  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="statement-summary.csv"
      head={["Customer", "Code", "District", "Total invoiced", "Balance due"]}
      rows={rows.map((r) => [r.name, r.code, r.district, formatAed(r.total), formatAed(r.balance)])}
    />
  );
}

function SalesTab() {
  const [rows, setRows] = useState<LeaderboardEntry[] | null>(null);
  useEffect(() => { fetchLeaderboard(supabaseBrowser()).then(setRows); }, []);
  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="sales-leaderboard.csv"
      head={["Salesman", "Month-to-date sales"]}
      rows={rows.map((r) => [r.name, formatAed(r.total)])}
    />
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4 aspect-[350/175] flex flex-col justify-center">
      <div className="text-caption text-secondary truncate">{label}</div>
      <div className="text-title font-bold mt-1 tabular-nums">{value}</div>
    </Card>
  );
}

function BalanceSheetTab() {
  const [data, setData] = useState<BalanceSheet | null>(null);
  useEffect(() => { fetchBalanceSheet(supabaseBrowser()).then(setData); }, []);
  if (!data) return <SkeletonList rows={4} />;
  return (
    <div>
      <div className="flex justify-end mb-2">
        <Button
          tier="plain"
          className="flex items-center gap-1.5"
          onClick={() =>
            downloadCsv(
              "balance-sheet.csv",
              ["Metric", "Value"],
              [
                ["Monthly sales", formatAed(data.monthlySales)],
                ["COGS", formatAed(data.cogs)],
                ["Monthly expense", formatAed(data.monthlyExpense)],
                ["Provision", formatAed(data.provision)],
                ["Profit / Loss", formatAed(data.profit)],
                ["Margin", `${(data.percentage * 100).toFixed(1)}%`],
              ]
            )
          }
        >
          <Download size={14} /> Download CSV
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricTile label="Monthly sales" value={formatAed(data.monthlySales)} />
        <MetricTile label="COGS" value={formatAed(data.cogs)} />
        <MetricTile label="Monthly expense" value={formatAed(data.monthlyExpense)} />
        <MetricTile label="Provision" value={formatAed(data.provision)} />
        <MetricTile label="Profit / Loss" value={formatAed(data.profit)} />
        <MetricTile label="Margin" value={`${(data.percentage * 100).toFixed(1)}%`} />
      </div>
    </div>
  );
}

function StockTab() {
  const [rows, setRows] = useState<StockSnapshotRow[] | null>(null);
  useEffect(() => { fetchStockSnapshot(supabaseBrowser()).then(setRows); }, []);
  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="stock-snapshot.csv"
      head={["SKU", "Name", "Stock on hand", "Price", "Value"]}
      rows={rows.map((r) => [r.sku, r.name, r.stockOnHand, formatAed(r.price), formatAed(r.value)])}
    />
  );
}

function PurchasesTab() {
  const [rows, setRows] = useState<PurchaseRow[] | null>(null);
  useEffect(() => { fetchPurchases(supabaseBrowser()).then(setRows); }, []);
  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="purchases.csv"
      head={["Date", "SKU", "Name", "Qty", "Total cost"]}
      rows={rows.map((r) => [
        new Date(r.grn_date).toLocaleDateString(),
        r.sku ?? "",
        r.name ?? "",
        r.qty,
        formatAed(r.total_cost),
      ])}
    />
  );
}

function GrvTab() {
  const [rows, setRows] = useState<GrvRow[] | null>(null);
  useEffect(() => { fetchGrvs(supabaseBrowser()).then(setRows); }, []);
  if (!rows) return <SkeletonList rows={5} />;
  return (
    <div>
      <div className="flex justify-end mb-2">
        <Button
          tier="plain"
          className="flex items-center gap-1.5"
          onClick={() =>
            downloadCsv(
              "grv.csv",
              ["Customer", "Date", "Status"],
              rows.map((g) => [g.customer?.name ?? "—", new Date(g.created_at).toLocaleDateString(), g.status])
            )
          }
        >
          <Download size={14} /> Download CSV
        </Button>
      </div>
      <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
        {rows.map((g) => (
          <div key={g.id} className="px-4 py-3 flex items-center justify-between">
            <div>
              <div className="text-subhead font-medium">{g.customer?.name ?? "—"}</div>
              <div className="text-caption text-secondary">{new Date(g.created_at).toLocaleDateString()}</div>
            </div>
            <Pill tone={g.status === "approved" ? "accent" : "warning"}>{g.status}</Pill>
          </div>
        ))}
      </div>
    </div>
  );
}
