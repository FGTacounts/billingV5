"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchOutstandingInvoices, summarizeByCustomer, AGING_BUCKETS } from "@/lib/queries/aging";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchBalanceSheet, fetchStockSnapshot, type BalanceSheet, type StockSnapshotRow } from "@/lib/queries/reports";
import { fetchLeaderboard, type LeaderboardEntry } from "@/lib/queries/sales";
import { fetchGrvs, fetchGrvProductReport, type GrvRow, type GrvProductRow } from "@/lib/queries/grv";
import { fetchPurchases, type PurchaseRow } from "@/lib/queries/purchases";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import { SkeletonList } from "@/components/ui/Empty";
import { Pill } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import Button from "@/components/ui/Button";
import ReportsBoard from "@/components/reports/ReportsBoard";
import type { SalesmanStatement } from "@/lib/statement";

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

const TABS = ["Customer Aging", "Statement Summary", "Salesman Statement", "Sales", "Balance Sheet", "Stock", "Purchases", "GRV"] as const;
type Tab = (typeof TABS)[number];
// The tab values above are data (state, equality checks); only what the
// reader sees is translated.
const TAB_LABELS: Record<Tab, string> = {
  "Customer Aging": t("reports.tabCustomerAging"),
  "Statement Summary": t("reports.tabStatementSummary"),
  "Salesman Statement": t("reports.tabSalesmanStatement"),
  Sales: t("nav.sales"),
  "Balance Sheet": t("reports.tabBalanceSheet"),
  Stock: t("reports.tabStock"),
  Purchases: t("reports.tabPurchases"),
  GRV: t("reports.tabGrv"),
};

export default function ReportsView() {
  const [tab, setTab] = useState<Tab>("Customer Aging");

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <h1 className="text-large-title font-bold mb-5">{t("nav.reports")}</h1>

      {/* The arrangeable sales-widget board, matching the iOS Reports tab.
          It sits above — and entirely separate from — the financial report
          tables, which are unchanged. */}
      <ReportsBoard />

      <div className="flex flex-wrap gap-1.5 mb-5">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 rounded-card text-caption font-semibold whitespace-nowrap border ${
              tab === t ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
            }`}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === "Customer Aging" && <CustomerAgingTab />}
      {tab === "Statement Summary" && <StatementSummaryTab />}
      {tab === "Salesman Statement" && <SalesmanStatementTab />}
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
          <Download size={14} /> {t("reports.downloadCsv")}
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
          .map((s) => ({ name: nameById.get(s.customerId) ?? t("common.notSet"), total: s.totalDue, buckets: s.buckets }))
          .sort((a, b) => b.total - a.total)
      );
    })();
  }, []);

  if (!rows) return <SkeletonList rows={5} />;
  return (
    <Table
      filename="customer-aging.csv"
      head={[t("reports.customer"), t("reports.totalDue"), ...AGING_BUCKETS.map((b) => b.label)]}
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
      head={[t("reports.customer"), t("reports.code"), t("reports.district"), t("reports.totalInvoiced"), t("reports.balanceDue")]}
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
      head={[t("nav.role.salesman"), t("reports.monthToDateSales")]}
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
              [t("reports.metric"), t("reports.value")],
              [
                [t("reports.monthlySales"), formatAed(data.monthlySales)],
                [t("reports.cogs"), formatAed(data.cogs)],
                [t("reports.monthlyExpense"), formatAed(data.monthlyExpense)],
                [t("reports.provision"), formatAed(data.provision)],
                [t("reports.profitLoss"), formatAed(data.profit)],
                [t("reports.margin"), `${(data.percentage * 100).toFixed(1)}%`],
              ]
            )
          }
        >
          <Download size={14} /> {t("reports.downloadCsv")}
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <MetricTile label={t("reports.monthlySales")} value={formatAed(data.monthlySales)} />
        <MetricTile label={t("reports.cogs")} value={formatAed(data.cogs)} />
        <MetricTile label={t("reports.monthlyExpense")} value={formatAed(data.monthlyExpense)} />
        <MetricTile label={t("reports.provision")} value={formatAed(data.provision)} />
        <MetricTile label={t("reports.profitLoss")} value={formatAed(data.profit)} />
        <MetricTile label={t("reports.margin")} value={`${(data.percentage * 100).toFixed(1)}%`} />
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
      head={[t("reports.sku"), t("sales.name"), t("reports.stockOnHand"), t("reports.price"), t("reports.value")]}
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
      head={[t("reports.date"), t("reports.sku"), t("sales.name"), t("reports.qty"), t("reports.totalCost")]}
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

// What is still owed on the orders one salesman took. Read through the same
// route the PDF and Excel come from, so the screen and the download are the
// same rows by construction.
function SalesmanStatementTab() {
  const [people, setPeople] = useState<{ id: string; full_name: string; role: string }[] | null>(null);
  const [salesmanId, setSalesmanId] = useState("");
  const [statement, setStatement] = useState<SalesmanStatement | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // Everyone who can bill, not only the roster of salesmen: a manager's own
  // orders are owed on too (2026-09-04, "the leaderboard names everyone who
  // billed").
  useEffect(() => {
    supabaseBrowser()
      .from("users")
      .select("id, full_name, role")
      .in("role", ["salesman", "manager", "admin"])
      .order("full_name")
      .then(({ data }) => setPeople((data ?? []).sort((a, b) => Number(b.role === "salesman") - Number(a.role === "salesman"))));
  }, []);

  useEffect(() => {
    if (!salesmanId) { setStatement(null); return; }
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    fetch(`/api/reports/salesman-statement?salesmanId=${encodeURIComponent(salesmanId)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data: SalesmanStatement) => { if (!cancelled) setStatement(data); })
      .catch(() => { if (!cancelled) { setStatement(null); setFailed(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [salesmanId]);

  const link = (format: "pdf" | "excel") =>
    `/api/reports/salesman-statement?salesmanId=${encodeURIComponent(salesmanId)}&format=${format}`;

  return (
    <div>
      <div className="flex items-end justify-between gap-3 flex-wrap mb-3">
        <label className="block">
          <span className="text-caption text-secondary font-semibold">{t("reports.ssPickSalesman")}</span>
          <select
            className="mt-1 block min-w-[220px] px-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
            value={salesmanId}
            onChange={(e) => setSalesmanId(e.target.value)}
          >
            <option value="">{t("common.notSet")}</option>
            {(people ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.role === "salesman" ? p.full_name : `${p.full_name} (${p.role})`}
              </option>
            ))}
          </select>
        </label>
        {salesmanId && statement && (
          <div className="flex items-center gap-2">
            <a href={link("pdf")} target="_blank" rel="noreferrer">
              <Button tier="plain" className="flex items-center gap-1.5"><Download size={14} /> {t("reports.ssPdf")}</Button>
            </a>
            <a href={link("excel")}>
              <Button tier="plain" className="flex items-center gap-1.5"><Download size={14} /> {t("reports.ssExcel")}</Button>
            </a>
          </div>
        )}
      </div>

      {!salesmanId ? (
        <div className="text-caption text-secondary">{t("reports.ssChooseSalesman")}</div>
      ) : loading ? (
        <SkeletonList rows={6} />
      ) : failed || !statement ? (
        <div className="text-caption text-[--status-danger]">{t("reports.ssLoadFailed")}</div>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Card className="p-4 text-center">
              <div className="text-caption text-secondary">{t("reports.ssToCollect")}</div>
              <div className="text-title font-bold tabular-nums">{formatAed(statement.totals.balance)}</div>
            </Card>
            <Card className="p-4 text-center">
              <div className="text-caption text-secondary">{t("reports.ssOverdue")}</div>
              <div className="text-title font-bold tabular-nums text-[--status-danger]">{formatAed(statement.totals.overdue)}</div>
            </Card>
            <Card className="p-4 text-center">
              <div className="text-caption text-secondary">{t("reports.ssCounts", { invoices: statement.rows.length, customers: statement.totals.customers })}</div>
              <div className="text-title font-bold tabular-nums">{formatAed(statement.totals.totalPayable)}</div>
            </Card>
          </div>
          {statement.rows.length === 0 ? (
            <div className="text-caption text-secondary">{t("reports.ssNothingOwed")}</div>
          ) : (
            <div className="bg-surface border border-hairline rounded-card overflow-x-auto">
              <table className="w-full text-subhead">
                <thead>
                  <tr className="text-caption text-secondary uppercase text-start border-b border-hairline">
                    <th className="px-3 py-2.5 font-medium text-start">{t("reports.date")}</th>
                    <th className="px-3 py-2.5 font-medium text-start">{t("reports.ssInvoice")}</th>
                    <th className="px-3 py-2.5 font-medium text-start">{t("reports.customer")}</th>
                    <th className="px-3 py-2.5 font-medium text-end">{t("common.total")}</th>
                    <th className="px-3 py-2.5 font-medium text-end">{t("reports.ssReceived")}</th>
                    <th className="px-3 py-2.5 font-medium text-end">{t("reports.ssBalance")}</th>
                    <th className="px-3 py-2.5 font-medium text-end">{t("reports.ssDays")}</th>
                  </tr>
                </thead>
                <tbody>
                  {statement.rows.map((r) => (
                    <tr key={r.orderId} className="border-b border-hairline last:border-0">
                      <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{new Date(r.date).toLocaleDateString("en-GB")}</td>
                      <td className="px-3 py-2.5 tabular-nums">{r.invNo}</td>
                      <td className="px-3 py-2.5">
                        {r.customerName} <span className="text-caption text-secondary tabular-nums">{r.customerCode}</span>
                      </td>
                      <td className="px-3 py-2.5 text-end tabular-nums">{formatAed(r.totalPayable)}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums text-secondary">{r.received ? formatAed(r.received) : ""}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums font-semibold">{formatAed(r.balance)}</td>
                      <td className="px-3 py-2.5 text-end tabular-nums whitespace-nowrap">
                        {r.days} {r.overdue && <Pill tone="danger">{t("reports.ssOverduePill")}</Pill>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GrvTab() {
  const [rows, setRows] = useState<GrvRow[] | null>(null);
  // Which products came back — approved returns only. This is what the
  // products a manager enters on a return request are for.
  const [products, setProducts] = useState<GrvProductRow[] | null>(null);
  useEffect(() => {
    const supabase = supabaseBrowser();
    fetchGrvs(supabase).then(setRows);
    fetchGrvProductReport(supabase).then(setProducts).catch(() => setProducts([]));
  }, []);
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
              [t("reports.customer"), t("reports.date"), t("reports.status"), t("reports.grvCredit")],
              rows.map((g) => [
                g.customer?.name ?? t("common.notSet"),
                new Date(g.created_at).toLocaleDateString(),
                g.status,
                g.creditValue.toFixed(2),
              ])
            )
          }
        >
          <Download size={14} /> {t("reports.downloadCsv")}
        </Button>
      </div>
      <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
        {rows.map((g) => (
          <div key={g.id} className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-subhead font-medium truncate">{g.customer?.name ?? t("common.notSet")}</div>
              <div className="text-caption text-secondary">{new Date(g.created_at).toLocaleDateString()}</div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-subhead tabular-nums">{formatAed(g.creditValue)}</span>
              <Pill tone={g.status === "approved" ? "accent" : "warning"}>{g.status}</Pill>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-6 mb-2">
        <h3 className="text-headline font-semibold">{t("reports.grvByProduct")}</h3>
        {products && products.length > 0 && (
          <Button
            tier="plain"
            className="flex items-center gap-1.5"
            onClick={() =>
              downloadCsv(
                "grv-products.csv",
                [t("reports.sku"), t("reports.product"), t("reports.grvQtyReturned"), t("reports.grvReturns"), t("reports.grvValue")],
                products.map((p) => [p.sku, p.name, String(p.qty), String(p.returns), p.value.toFixed(2)])
              )
            }
          >
            <Download size={14} /> {t("reports.downloadCsv")}
          </Button>
        )}
      </div>
      {!products ? (
        <SkeletonList rows={3} />
      ) : products.length === 0 ? (
        <div className="text-caption text-secondary">{t("reports.grvNoProducts")}</div>
      ) : (
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
          {products.map((p) => (
            <div key={p.productId} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-subhead font-medium truncate">{p.name || p.sku}</div>
                <div className="text-caption text-secondary tabular-nums">
                  {p.sku} · {t("reports.grvAcrossReturns", { n: p.returns })}
                </div>
              </div>
              <div className="text-end shrink-0">
                <div className="text-subhead font-semibold tabular-nums">{p.qty}</div>
                <div className="text-caption text-secondary tabular-nums">{formatAed(p.value)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
