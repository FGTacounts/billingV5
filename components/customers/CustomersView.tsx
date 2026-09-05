"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Search, Plus, Users, FileDown, FileSpreadsheet, SlidersHorizontal } from "lucide-react";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { requestCustomerChange } from "@/lib/queries/customerRequests";
import { toast } from "@/lib/toast";
import PinnableOptionsButton from "@/components/ui/PinnableOptions";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchCustomers, createCustomer, updateCustomer } from "@/lib/queries/customers";
import { fetchZoneCountries, type ZoneCountry } from "@/lib/queries/zones";
import {
  fetchOutstandingInvoices,
  summarizeByCustomer,
  conditionForDays,
  type Condition,
} from "@/lib/queries/aging";
import type { AppUser, Customer } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { StaggerList } from "@/components/ui/StaggerList";
import { usePagination, Pagination } from "@/components/ui/Pagination";
import { Pill, StatusSquare } from "@/components/ui/Badge";
import Button from "@/components/ui/Button";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { CUSTOMER_ALIASES } from "@/lib/importAliases";
import Sheet from "@/components/ui/Sheet";
import { Label, TextInput } from "@/components/ui/Field";
import CustomerDetailView from "./CustomerDetailView";
import { DEFAULT_OVERDUE_DAYS } from "@/lib/queries/aging";

const CONDITION_TONE: Record<Condition, "accent" | "warning" | "danger"> = {
  excellent: "accent",
  moderate: "warning",
  bad: "danger",
};
const CONDITION_LABEL: Record<Condition, string> = {
  excellent: "Excellent",
  moderate: "Moderate",
  bad: "Bad",
};

type QuickFilter = "all" | "overdue" | "needsPayment" | "excellent";
const QUICK_FILTERS: { value: QuickFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "needsPayment", label: "Payments needed" },
  { value: "excellent", label: "Excellent" },
];

// Real ascending/descending sort (§Customers), separate from the
// condition/overdue filter above.
type SortKey = "name_asc" | "name_desc" | "balance_desc" | "balance_asc" | "sale_desc" | "sale_asc";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "name_asc", label: "Name (A–Z)" },
  { key: "name_desc", label: "Name (Z–A)" },
  { key: "balance_desc", label: "Balance (highest to lowest)" },
  { key: "balance_asc", label: "Balance (lowest to highest)" },
  { key: "sale_desc", label: "Sale (highest to lowest)" },
  { key: "sale_asc", label: "Sale (lowest to highest)" },
];

// Next code = highest existing numeric code + 1 — shared by the new-
// customer form default and the import sample sheet (§Customers: "make
// sure the customer code starts from the next number"). Not a hard rule,
// just a sane starting point the Manager can still change.
async function nextCustomerCode(): Promise<number> {
  const { data } = await supabaseBrowser().from("customers").select("code");
  return (data ?? []).reduce((max, r) => {
    const n = parseInt(r.code, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 20000) + 1;
}

// Adjust View (§Customers: "there is no sort option nor an adjust view
// option"): which optional info shows per customer row, individually
// toggleable, plus a couple of named default views. Name/code/Balance/
// condition stay as fixed identity+status columns — only these are
// optional, same split as the Products page's Adjust View.
type CustomerColumnKey = "district" | "sale" | "payment" | "vat";
const ALL_CUSTOMER_COLUMNS: CustomerColumnKey[] = ["district", "sale", "payment", "vat"];
const CUSTOMER_COLUMN_LABELS: Record<CustomerColumnKey, string> = {
  district: "District",
  sale: "Sale",
  payment: "Payment",
  vat: "VAT number",
};
const CUSTOMER_VIEWS: { key: string; label: string; columns: CustomerColumnKey[] }[] = [
  { key: "default", label: "Default", columns: ["district", "sale", "payment"] },
  { key: "financial", label: "Financial", columns: ["sale", "payment", "vat"] },
  { key: "compact", label: "Compact", columns: [] },
  { key: "all", label: "All columns", columns: ALL_CUSTOMER_COLUMNS },
];

function CustomerAdjustViewPopover({
  activeColumns,
  activeViewKey,
  onSelectView,
  onToggleColumn,
}: {
  activeColumns: CustomerColumnKey[];
  activeViewKey: string | undefined;
  onSelectView: (view: (typeof CUSTOMER_VIEWS)[number]) => void;
  onToggleColumn: (col: CustomerColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2.5 rounded-full border border-hairline text-secondary hover:text-accent"
        aria-label="Adjust view"
        title="Adjust view"
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-64 glass rounded-card shadow-floating z-20 p-3">
            <div className="text-caption text-secondary font-semibold mb-1.5">Default views</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {CUSTOMER_VIEWS.map((v) => (
                <button
                  key={v.key}
                  onClick={() => onSelectView(v)}
                  className={`px-2.5 py-1 rounded-card text-caption font-medium border ${
                    activeViewKey === v.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="text-caption text-secondary font-semibold mb-1.5">Columns</div>
            {ALL_CUSTOMER_COLUMNS.map((col) => (
              <label key={col} className="flex items-center gap-2 py-1 text-subhead">
                <input type="checkbox" checked={activeColumns.includes(col)} onChange={() => onToggleColumn(col)} />
                {CUSTOMER_COLUMN_LABELS[col]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default function CustomersView({ user, isManager }: { user: AppUser; isManager: boolean }) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [aging, setAging] = useState<Map<string, { totalDue: number; totalSale: number; totalPaid: number; oldestDays: number }>>(new Map());
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [quickFilter, setQuickFilter] = useState<QuickFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey | "">("");
  const { preferences, update: updatePrefs } = usePreferences();
  const pinnedFilters = preferences.pinnedCustomerFilters ?? [];
  const pinnedSorts = preferences.pinnedCustomerSort ?? [];
  // §Global quick-download preference — Excel stays Manager-only regardless
  // of the setting, matching every other Excel export in the app.
  const quickFormat = preferences.quickDownloadFormat ?? "pdf";
  const showPdfQuickDownload = quickFormat === "pdf" || quickFormat === "both" || !isManager;
  const showExcelQuickDownload = isManager && (quickFormat === "excel" || quickFormat === "both");
  const activeCustomerView = CUSTOMER_VIEWS.find((v) => v.key === preferences.customerView) ?? CUSTOMER_VIEWS[0];
  const activeCustomerColumns = (preferences.customerColumns as CustomerColumnKey[] | undefined) ?? activeCustomerView.columns;

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const [rows, invoices] = await Promise.all([
      fetchCustomers(supabase, { search: search || undefined }),
      // includeSettled=true — the Sale/Payment columns need lifetime totals,
      // not just what's still outstanding.
      fetchOutstandingInvoices(supabase, undefined, true).catch(() => []),
    ]);
    setCustomers(rows);
    setAging(summarizeByCustomer(invoices));
    setLoading(false);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const grouped = useMemo(() => {
    // Shown one row per shop, never merged (§Next Updates: "remove the
    // combine shops button" — the grouped-by-shop-name view it toggled is
    // gone along with it).
    const base = customers.map((c) => ({ key: c.id, label: c.name, members: [c] }));

    return base.map((g) => {
      const totalDue = g.members.reduce((s, c) => s + (aging.get(c.id)?.totalDue ?? 0), 0);
      const totalSale = g.members.reduce((s, c) => s + (aging.get(c.id)?.totalSale ?? 0), 0);
      const totalPaid = g.members.reduce((s, c) => s + (aging.get(c.id)?.totalPaid ?? 0), 0);
      const oldest = Math.max(0, ...g.members.map((c) => aging.get(c.id)?.oldestDays ?? 0));
      // No order/invoice history at all reads as "-", not a fabricated
      // "Excellent" (§Next Updates: "if there is no previous data, then
      // just use a dash").
      const hasData = g.members.some((c) => aging.has(c.id));
      const condition = hasData ? conditionForDays(oldest) : null;
      const groupThreshold = Math.min(...g.members.map((c) => c.overdue_threshold_days ?? DEFAULT_OVERDUE_DAYS));
      return { ...g, totalDue, totalSale, totalPaid, oldest, condition, hasData, groupThreshold, overdue: oldest > groupThreshold };
    });
  }, [customers, aging]);

  const visibleGroups = useMemo(() => {
    let rows = grouped;
    if (quickFilter === "overdue") rows = rows.filter((g) => g.overdue);
    else if (quickFilter === "needsPayment") rows = rows.filter((g) => g.totalDue > 0.01);
    else if (quickFilter === "excellent") rows = rows.filter((g) => g.condition === "excellent");

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        switch (sortKey) {
          case "name_asc": return a.label.localeCompare(b.label);
          case "name_desc": return b.label.localeCompare(a.label);
          case "balance_desc": return b.totalDue - a.totalDue;
          case "balance_asc": return a.totalDue - b.totalDue;
          case "sale_desc": return b.totalSale - a.totalSale;
          case "sale_asc": return a.totalSale - b.totalSale;
        }
      });
    }
    return rows;
  }, [grouped, quickFilter, sortKey]);

  // 350 customer rows at once contributed to the scroll stalling; paging
  // keeps the rendered set small.
  const pager = usePagination(visibleGroups, 50);

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">Customers</h1>
        <div className="flex items-center gap-4 flex-wrap">
        {isManager && (
            <ImportCsvButton
              endpoint="/api/customers/import"
              onImported={load}
              aliases={CUSTOMER_ALIASES}
              sample={{
                // Header labels match Billing Customers.xlsx (Code, CUSTOMER
                // NAME, District, Address, VAT NO) plus GROUP NAME from the
                // Statement sheet, so either source can upload as-is.
                filename: "customers_sample.csv",
                headers: [
                  { key: "Code", required: true },
                  { key: "CUSTOMER NAME", required: true },
                  { key: "District", required: true },
                  { key: "Address", required: true },
                  { key: "VAT NO", required: true },
                  { key: "GROUP NAME" },
                  { key: "Contact Details" },
                  { key: "Overdue Threshold Days" },
                ],
                // Computed live at download time, not a stale hardcoded
                // number (§Customers: "make sure the customer code starts
                // from the next number").
                example: async () => ({
                  Code: String(await nextCustomerCode()),
                  "CUSTOMER NAME": "Example Trading LLC",
                  District: "DUBAI",
                  Address: "Example street, Dubai",
                  "VAT NO": "100000000000000",
                  "GROUP NAME": "",
                  "Contact Details": "",
                  "Overdue Threshold Days": 90,
                }),
              }}
            />
          )}
          {isManager && <ExportLink type="customers" />}
          {/* Anyone can start a customer; only a manager's lands straight
              away. The label says which is happening rather than letting
              someone find out after typing it all in. */}
          <Button tier="primary" onClick={() => setEditing("new")} className="flex items-center gap-1.5">
            <Plus size={16} /> {isManager ? "Add customer" : "Suggest customer"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            className="w-full pl-9 pr-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
            placeholder="Search name, code, or shop group"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <PinnableOptionsButton
          label="Filter"
          options={QUICK_FILTERS.map((f) => ({ key: f.value, label: f.label }))}
          active={quickFilter}
          pinned={pinnedFilters}
          onSelect={(key) => setQuickFilter(key as QuickFilter)}
          onTogglePin={(key) =>
            updatePrefs({
              pinnedCustomerFilters: pinnedFilters.includes(key)
                ? pinnedFilters.filter((k) => k !== key)
                : [...pinnedFilters, key],
            })
          }
        />
        <PinnableOptionsButton
          label="Sort"
          options={SORT_OPTIONS.map((s) => ({ key: s.key, label: s.label }))}
          active={sortKey}
          pinned={pinnedSorts}
          onSelect={(key) => setSortKey(sortKey === key ? "" : (key as SortKey))}
          onTogglePin={(key) =>
            updatePrefs({
              pinnedCustomerSort: pinnedSorts.includes(key)
                ? pinnedSorts.filter((k) => k !== key)
                : [...pinnedSorts, key],
            })
          }
        />
        <CustomerAdjustViewPopover
          activeColumns={activeCustomerColumns}
          activeViewKey={preferences.customerColumns ? undefined : activeCustomerView.key}
          onSelectView={(v) => updatePrefs({ customerView: v.key, customerColumns: v.columns })}
          onToggleColumn={(col) =>
            updatePrefs({
              customerColumns: activeCustomerColumns.includes(col)
                ? activeCustomerColumns.filter((c) => c !== col)
                : [...activeCustomerColumns, col],
            })
          }
        />
      </div>

      {/* Nothing shows here unless the user has explicitly pinned it —
          no default filter/sort chips (§Customers). */}
      {(pinnedFilters.length > 0 || pinnedSorts.length > 0) && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {QUICK_FILTERS.filter((f) => pinnedFilters.includes(f.value)).map((f) => (
            <button
              key={f.value}
              onClick={() => setQuickFilter(f.value)}
              className={`px-3.5 py-1.5 rounded-card border text-caption font-medium transition ${
                quickFilter === f.value ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              {f.label}
            </button>
          ))}
          {SORT_OPTIONS.filter((s) => pinnedSorts.includes(s.key)).map((s) => (
            <button
              key={s.key}
              onClick={() => setSortKey(sortKey === s.key ? "" : s.key)}
              className={`px-3.5 py-1.5 rounded-card border text-caption font-medium transition ${
                sortKey === s.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <SkeletonList rows={6} />
      ) : visibleGroups.length === 0 ? (
        <EmptyState icon={Users} title="No customers found" />
      ) : (
        <div className="bg-surface border border-hairline rounded-card overflow-hidden">
          {/* Column header, as the desktop mockup draws it. Phone rows label
              each figure inline instead, so this is desktop-only. */}
          <div className="hidden sm:flex items-center justify-between gap-3 px-4 py-2 text-caption text-secondary uppercase font-medium border-b border-hairline">
            <span className="flex-1">Name</span>
            <span
              className={`grid ${
                activeCustomerColumns.includes("sale") && activeCustomerColumns.includes("payment")
                  ? "grid-cols-3"
                  : activeCustomerColumns.includes("sale") || activeCustomerColumns.includes("payment")
                    ? "grid-cols-2"
                    : "grid-cols-1"
              } gap-4 w-[330px] shrink-0 text-right`}
            >
              {activeCustomerColumns.includes("sale") && <span>Sale</span>}
              {activeCustomerColumns.includes("payment") && <span>Payment</span>}
              <span>Balance</span>
            </span>
            <span className="shrink-0 w-[150px] text-right">Condition</span>
          </div>
          <StaggerList className="divide-y divide-hairline">
          {pager.visible.map((g) => {
            // Manager sees lifetime collections in the Payment column;
            // Salesman/Warehouse see the same pending/outstanding figure
            // that's already in Balance, per §1.6/§2.5's role-scoped column.
            const paymentColumnValue = isManager ? g.totalPaid : g.totalDue;
            // Sale/Payment are optional (§Customers Adjust View) — Balance
            // always shows, it's the one figure that answers "do they owe
            // us money" at a glance.
            const financialCols: { key: string; label: string; value: string; emphasis?: boolean }[] = [];
            if (activeCustomerColumns.includes("sale")) financialCols.push({ key: "sale", label: "Sale", value: formatAed(g.totalSale) });
            if (activeCustomerColumns.includes("payment")) financialCols.push({ key: "payment", label: "Payment", value: formatAed(paymentColumnValue) });
            financialCols.push({ key: "balance", label: "Balance", value: formatAed(g.totalDue), emphasis: true });
            const gridColsClass = financialCols.length === 3 ? "grid-cols-3" : financialCols.length === 2 ? "grid-cols-2" : "grid-cols-1";
            const showVat = activeCustomerColumns.includes("vat") && g.members.length === 1 && g.members[0].vat_number;
            return (
              <div
                key={g.key}
                className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] cursor-pointer"
                onClick={() => g.members.length === 1 && setViewing(g.members[0])}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-headline font-bold truncate">{g.label}</div>
                  <div className="text-caption text-secondary truncate">
                    {g.members.map((c) => c.code).join(", ")}
                    {activeCustomerColumns.includes("district") && g.members[0]?.district ? ` · ${g.members[0].district}` : ""}
                    {showVat ? ` · VAT ${g.members[0].vat_number}` : ""}
                  </div>
                </div>
                {/* Sale / Payment / Balance. On a phone these drop to their
                    own full-width line under the name rather than being
                    hidden — the iPhone mockup makes them the whole row. */}
                <div className={`grid ${gridColsClass} gap-4 w-full sm:w-[330px] shrink-0 text-right`}>
                  {financialCols.map((c) => (
                    <div key={c.key}>
                      {/* Desktop has a column header above the list, so the
                          per-row label is phone-only. */}
                      <div className="sm:hidden text-caption text-secondary">{c.label}</div>
                      <div className={`text-headline tabular-nums font-bold ${c.emphasis ? "text-accent" : ""}`}>{c.value}</div>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto sm:w-[150px] sm:justify-end">
                  {g.overdue && <Pill tone="danger">Overdue</Pill>}
                  <StatusSquare
                    tone={g.condition ? CONDITION_TONE[g.condition] : "neutral"}
                    label={g.condition ? CONDITION_LABEL[g.condition] : "No data"}
                  />
                  {g.members.length === 1 && showPdfQuickDownload && (
                    <a
                      href={`/api/customers/statement?customerId=${g.members[0].id}&format=pdf`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 text-secondary hover:text-accent"
                      aria-label="Download statement (PDF)"
                      title="Download statement (PDF)"
                    >
                      <FileDown size={15} />
                    </a>
                  )}
                  {g.members.length === 1 && showExcelQuickDownload && (
                    <a
                      href={`/api/customers/statement?customerId=${g.members[0].id}&format=excel`}
                      onClick={(e) => e.stopPropagation()}
                      className="p-1.5 text-secondary hover:text-accent"
                      aria-label="Download statement (Excel)"
                      title="Download statement (Excel)"
                    >
                      <FileSpreadsheet size={15} />
                    </a>
                  )}
                </div>
              </div>
            );
          })}
          </StaggerList>
        </div>
      )}

      <Pagination {...pager} noun="customers" />

      {editing && (
        <CustomerEditor
          asRequest={!isManager}
          requestedBy={user.id}
          // Same remount guard as ProductEditor — without it, going from
          // editing a customer to "Add customer" reuses the instance and
          // opens the new-customer form prefilled with the old data.
          key={editing === "new" ? "new" : editing.id}
          customer={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setViewing(null);
            load();
          }}
        />
      )}

      {viewing && (
        <CustomerDetailView
          customer={viewing}
          user={user}
          onClose={() => setViewing(null)}
          onEdit={() => { setEditing(viewing); setViewing(null); }}
          onDeleted={() => { setViewing(null); load(); }}
        />
      )}
    </div>
  );
}

function CustomerEditor({
  customer,
  onClose,
  onSaved,
  // A manager writes straight to the record. Anyone else is raising a change
  // for a manager to look at, and the screen says so rather than pretending
  // the edit has landed.
  asRequest = false,
  requestedBy,
}: {
  customer: Customer | null;
  onClose: () => void;
  onSaved: () => void;
  asRequest?: boolean;
  requestedBy?: string;
}) {
  const [form, setForm] = useState({
    code: customer?.code ?? "",
    name: customer?.name ?? "",
    group_name: customer?.group_name ?? "",
    district: customer?.district ?? "",
    address: customer?.address ?? "",
    phone: customer?.phone ?? "", // "Contact details" in the UI — kept as `phone` at the data layer
    vat_number: customer?.vat_number ?? "",
    // Global default is 90 days now (Problems and Updates — Customers §),
    // still overridable per customer.
    overdue_threshold_days: customer?.overdue_threshold_days ?? 90,
    country_code: customer?.country_code ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [countries, setCountries] = useState<ZoneCountry[]>([]);

  useEffect(() => {
    const supabase = supabaseBrowser();
    supabase
      .from("customers")
      .select("group_name")
      .not("group_name", "is", null)
      .then(({ data }) => {
        const groups = [...new Set((data ?? []).map((r) => r.group_name).filter(Boolean))] as string[];
        setExistingGroups(groups.sort());
      });
    if (!customer) {
      nextCustomerCode().then((code) => setForm((f) => ({ ...f, code: String(code) })));
    }
    fetchZoneCountries(supabase).then(setCountries);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    setSaving(true);
    const supabase = supabaseBrowser();
    try {
      if (asRequest) {
        const result = await requestCustomerChange(supabase, {
          customerId: customer?.id ?? null,
          payload: customer ? form : { ...form, is_active: true },
          requestedBy: requestedBy ?? "",
        });
        if (!result.ok) {
          toast.error(result.error ?? "Couldn't send that for approval.");
          return;
        }
        toast.success(
          customer
            ? "Sent to your manager to approve."
            : "New customer sent to your manager to approve."
        );
        onSaved();
        return;
      }
      if (customer) await updateCustomer(supabase, customer.id, form);
      else await createCustomer(supabase, { ...form, is_active: true });
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  const canSave = form.name && form.code && form.district && form.address && form.vat_number;

  return (
    <Sheet
      open
      onClose={onClose}
      title={
        asRequest
          ? customer
            ? "Suggest a change"
            : "Suggest a customer"
          : customer
            ? "Edit customer"
            : "Add customer"
      }
      footer={
        <>
          <Button tier="plain" onClick={onClose}>Cancel</Button>
          <Button tier="primary" onClick={save} disabled={saving || !canSave}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Label>Customer code {!customer && "(auto — editable)"}</Label>
      <TextInput
        value={form.code}
        onChange={(e) => setForm({ ...form, code: e.target.value })}
      />
      <Label>Name *</Label>
      <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <Label>Shop group (for combining shops under one account)</Label>
      <input
        list="shop-groups"
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
        value={form.group_name}
        onChange={(e) => setForm({ ...form, group_name: e.target.value })}
        placeholder="Pick an existing group or type a new one"
      />
      <datalist id="shop-groups">
        {existingGroups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <Label>District *</Label>
      <TextInput value={form.district} onChange={(e) => setForm({ ...form, district: e.target.value })} />
      <Label>Address *</Label>
      <TextInput value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
      <Label>Contact details</Label>
      <TextInput value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      <Label>VAT number *</Label>
      <TextInput value={form.vat_number} onChange={(e) => setForm({ ...form, vat_number: e.target.value })} />
      {countries.length > 0 && (
        <>
          <Label>Country (sets VAT/currency by zone)</Label>
          <select
            className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
            value={form.country_code}
            onChange={(e) => setForm({ ...form, country_code: e.target.value })}
          >
            <option value="">Default zone</option>
            {countries.map((c) => (
              <option key={c.country_code} value={c.country_code}>{c.country_name}</option>
            ))}
          </select>
        </>
      )}
      <Label>Overdue threshold (days)</Label>
      <TextInput
        type="number"
        value={form.overdue_threshold_days}
        onChange={(e) => setForm({ ...form, overdue_threshold_days: Number(e.target.value) || 0 })}
      />
    </Sheet>
  );
}
