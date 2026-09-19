"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { Plus, CreditCard, Search, SlidersHorizontal, ArrowUpDown } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchExpenses, createExpense, updateExpense, deleteExpense, fetchSalesmen } from "@/lib/queries/expenses";
import { fetchExpenseBreakdown, type ExpenseSlice } from "@/lib/queries/dashboard";
import type { AppUser, Expense, ExpenseType } from "@/lib/types/db";
import type { Seller } from "@/lib/queries/sales";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { formatAed, formatCompact } from "@/lib/money";
import Button from "@/components/ui/Button";
import Sheet from "@/components/ui/Sheet";
import { Card } from "@/components/ui/Card";
import { DonutChart, SERIES_COLORS } from "@/components/ui/charts";
import { Label, TextInput } from "@/components/ui/Field";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { Pill } from "@/components/ui/Badge";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { EXPENSE_ALIASES } from "@/lib/importAliases";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import { usePreferences } from "@/lib/hooks/usePreferences";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { EXPENSE_SAMPLE_HEADERS, expenseSampleExample } from "@/lib/importSamples";

const TYPE_TONE: Record<ExpenseType, "info" | "warning" | "danger"> = {
  fixed: "info",
  variable: "warning",
  purchase: "danger",
};

const SUB_TABS: { key: ExpenseType | ""; label: string }[] = [
  { key: "", label: t("common.all") },
  { key: "fixed", label: t("expense.typeFixed") },
  { key: "variable", label: t("expense.typeVariable") },
  { key: "purchase", label: t("expense.typePurchase") },
];

type SortKey = "date_desc" | "date_asc" | "amount_desc" | "amount_asc";
const SORT_LABELS: Record<SortKey, string> = {
  date_desc: t("expense.sortNewestFirst"),
  date_asc: t("expense.sortOldestFirst"),
  amount_desc: t("expense.sortAmountHighToLow"),
  amount_asc: t("expense.sortAmountLowToHigh"),
};

export default function ExpenseView({ user }: { user: AppUser }) {
  const [topTab, setTopTab] = useState<"overview" | "salesman">("overview");
  const [salesmen, setSalesmen] = useState<Seller[]>([]);
  const [selectedSalesman, setSelectedSalesman] = useState("");
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [breakdown, setBreakdown] = useState<{ slices: ExpenseSlice[]; total: number }>({ slices: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [typeFilter, setTypeFilter] = useState<ExpenseType | "">("");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date_desc");
  const [sortOpen, setSortOpen] = useState(false);
  const { preferences, update: updatePrefs } = usePreferences();
  const subTabsVisible = preferences.expenseSubTabsVisible !== false;

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const [rows, eb, sm] = await Promise.all([
      fetchExpenses(supabase, { type: typeFilter || undefined }),
      fetchExpenseBreakdown(supabase),
      salesmen.length ? Promise.resolve(salesmen) : fetchSalesmen(supabase),
    ]);
    setExpenses(rows);
    setBreakdown(eb);
    if (!salesmen.length) setSalesmen(sm);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // Whose expense it is. `salesman_id` is the answer when it has been set;
  // `logged_by` is only who typed it in, and since logging is Manager-gated
  // that was every row — which is why the Salesman tab used to be empty.
  // Older rows entered by a salesman keep working through the fallback.
  const attributedTo = useCallback(
    (e: Expense): string | null => {
      if (e.salesman_id) return e.salesman_id;
      // Only a salesman's own entry falls back this way. A manager appears
      // in the same list because a manager can carry an expense too, but
      // "the manager typed it in" is not "it is the manager's expense".
      return salesmen.some((s) => s.id === e.logged_by && s.role === "salesman") ? e.logged_by : null;
    },
    [salesmen]
  );

  const visible = useMemo(() => {
    let rows = expenses;
    if (topTab === "salesman") {
      rows = rows.filter((e) => {
        const owner = attributedTo(e);
        return owner !== null && (!selectedSalesman || owner === selectedSalesman);
      });
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (e) => (e.description ?? "").toLowerCase().includes(q) || (e.category ?? "").toLowerCase().includes(q)
      );
    }
    const sorted = [...rows];
    switch (sortKey) {
      case "date_desc": sorted.sort((a, b) => b.date.localeCompare(a.date)); break;
      case "date_asc": sorted.sort((a, b) => a.date.localeCompare(b.date)); break;
      case "amount_desc": sorted.sort((a, b) => b.amount - a.amount); break;
      case "amount_asc": sorted.sort((a, b) => a.amount - b.amount); break;
    }
    return sorted;
  }, [expenses, topTab, attributedTo, selectedSalesman, search, sortKey]);

  const totalShown = visible.reduce((s, e) => s + e.amount, 0);
  const salesmanName = (id: string | null) => (id ? salesmen.find((s) => s.id === id)?.name : undefined);

  // Optimistic removal with a real rollback (§0.2): the row leaves the list
  // and the sheet closes the moment you confirm, and a refused delete puts
  // the row back exactly where it was rather than leaving the screen
  // claiming something is gone that isn't. The donut and the running total
  // are derived from the same state, so both move with it.
  const removeExpense = useCallback(async (expense: Expense) => {
    const previous = expenses;
    setExpenses((rows) => rows.filter((r) => r.id !== expense.id));
    try {
      await deleteExpense(supabaseBrowser(), expense.id);
      toast.success(t("expense.deleted"));
      // The category breakdown is computed server-side, so it only agrees
      // again after a reload. Deliberately after the success, not instead
      // of the optimistic removal.
      load();
    } catch (e) {
      setExpenses(previous);
      toast.error(friendlyError(e, t("expense.deleteFailed")));
    }
  }, [expenses, load]);

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">{t("nav.expense")}</h1>
        <div className="flex items-center gap-4 flex-wrap">
          <ImportCsvButton
            endpoint="/api/expenses/import"
            onImported={load}
            aliases={EXPENSE_ALIASES}
            sample={{
              // Header labels match V5.0 Reports.xlsx's FIXED/VARIABLE
              // EXPENSE and PURCHASE sheets (TYPE/DATE/AMOUNT/DESCRIPTION/
              // NOTES) — Category has no direct source column there and is
              // our own required field, so it's called out explicitly.
              filename: "expenses_sample.csv",
              headers: EXPENSE_SAMPLE_HEADERS,
            example: expenseSampleExample(),
            }}
          />
          <ExportLink type="expenses" />
          <Button tier="primary" onClick={() => setShowNew(true)} className="flex items-center gap-1.5">
            <Plus size={16} /> {t("expense.logExpense")}
          </Button>
        </div>
      </div>

      {/* Salesman / Overview (§Expense: "separate views for both salesman
          and overview expense — two tabs inside of expense") */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <SegmentedControl
          layoutId="expense-top-tab"
          value={topTab}
          onChange={setTopTab}
          segments={[
            { key: "overview" as const, label: t("expense.overview") },
            { key: "salesman" as const, label: t("expense.salesman") },
          ]}
        />
        {topTab === "salesman" && (
          <select
            className="px-3 py-1.5 rounded-card border border-hairline bg-surface text-caption font-medium"
            value={selectedSalesman}
            onChange={(e) => setSelectedSalesman(e.target.value)}
          >
            <option value="">{t("expense.allSalesmen")}</option>
            {salesmen.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
      </div>

      {breakdown.total > 0 && (
        // §desktop Expense mockup: category legend on the left, the donut
        // large on the right, with the total in its centre.
        <Card className="p-6 mb-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-6">
          <div className="flex flex-col gap-1.5 min-w-0">
            <div className="text-title font-bold mb-1">{t("nav.expense")}</div>
            {breakdown.slices.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2.5 text-subhead">
                <span
                  className="w-5 h-2.5 rounded-[2px] shrink-0"
                  style={{ background: SERIES_COLORS[i % SERIES_COLORS.length] }}
                />
                <span className="truncate">{s.label}</span>
              </div>
            ))}
          </div>
          <DonutChart
            slices={breakdown.slices}
            total={breakdown.total}
            size={220}
            showLegend={false}
            // Was `${Math.round(total/1000)}k`, which rendered every total
            // under 500 as a flat "0k".
            centerLabel={formatCompact(breakdown.total)}
          />
        </Card>
      )}

      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {subTabsVisible && (
          <div className="flex gap-1.5 flex-wrap">
            {SUB_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTypeFilter(t.key)}
                className={`px-3 py-1.5 rounded-card text-caption font-semibold border ${
                  typeFilter === t.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2 ms-auto">
          <div className="relative">
            <Search size={13} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-secondary" />
            <input
              className="ps-7 pe-2.5 py-1.5 rounded-card border border-hairline bg-surface text-caption outline-none focus:border-accent w-32 sm:w-40"
              placeholder={t("common.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="relative">
            <button
              onClick={() => setSortOpen((v) => !v)}
              className="p-2 rounded-full border border-hairline text-secondary hover:text-accent"
              aria-label={t("expense.sort")}
              title={t("expense.sort")}
            >
              <ArrowUpDown size={14} />
            </button>
            {sortOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setSortOpen(false)} />
                <div className="absolute end-0 mt-2 w-52 glass rounded-card shadow-floating z-20 p-1.5">
                  {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                    <button
                      key={k}
                      onClick={() => { setSortKey(k); setSortOpen(false); }}
                      className={`w-full text-left px-2.5 py-1.5 rounded-inner text-caption font-medium ${
                        sortKey === k ? "bg-accent/10 text-accent" : "text-secondary hover:bg-canvas"
                      }`}
                    >
                      {SORT_LABELS[k]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <button
            onClick={() => updatePrefs({ expenseSubTabsVisible: !subTabsVisible })}
            className="p-2 rounded-full border border-hairline text-secondary hover:text-accent"
            aria-label={t("expense.adjustView")}
            title={subTabsVisible ? t("expense.hideCategoryTabs") : t("expense.showCategoryTabs")}
          >
            <SlidersHorizontal size={14} />
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonList rows={5} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title={topTab === "salesman" ? t("expense.noSalesmanExpensesYet") : t("expense.noExpensesLogged")}
        />
      ) : (
        <>
          <div className="text-right text-subhead font-semibold tabular-nums mb-2">
            {t("expense.totalAmount", { amount: formatAed(totalShown) })}
          </div>
          {/* Date · Description · AMT, as the iPhone mockup draws it — the
              date leads the row rather than sitting in a subtitle. */}
          <div className="bg-surface border border-hairline rounded-card overflow-hidden">
            <div className="grid grid-cols-[86px_1fr_auto] sm:grid-cols-[100px_90px_1fr_auto] gap-3 px-4 py-2 text-caption text-secondary uppercase font-medium border-b border-hairline">
              <span>{t("expense.date")}</span>
              <span className="hidden sm:block">{t("expense.type")}</span>
              <span>{t("expense.description")}</span>
              <span className="text-right">{t("expense.amount")}</span>
            </div>
            <div className="divide-y divide-hairline">
              {visible.map((e) => (
                <button
                  key={e.id}
                  onClick={() => setEditing(e)}
                  className="w-full text-left px-4 py-3 grid grid-cols-[86px_1fr_auto] sm:grid-cols-[100px_90px_1fr_auto] gap-3 items-center hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                >
                  <span className="text-caption text-secondary uppercase leading-tight">
                    {new Date(e.date).toLocaleDateString("en-GB", {
                      day: "2-digit",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                  {/* Type gets its own column on desktop, as drawn; on a
                      phone it rides along with the amount instead. */}
                  <span className="hidden sm:block">
                    <Pill tone={TYPE_TONE[e.type]}>{e.type}</Pill>
                  </span>
                  <span className="min-w-0">
                    <span className="block text-subhead font-medium truncate">
                      {e.description || e.category || t("common.notSet")}
                    </span>
                    <span className="block text-caption text-secondary truncate">
                      {e.category ?? ""}
                      {salesmanName(attributedTo(e))
                        ? t("expense.salesmanSuffix", { name: salesmanName(attributedTo(e)) ?? "" })
                        : ""}
                    </span>
                  </span>
                  <span className="flex items-center justify-end gap-2 shrink-0">
                    <span className="sm:hidden">
                      <Pill tone={TYPE_TONE[e.type]}>{e.type}</Pill>
                    </span>
                    <span className="tabular-nums font-semibold">{formatAed(e.amount)}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {showNew && (
        <ExpenseEditor
          onClose={() => setShowNew(false)}
          onSaved={() => { setShowNew(false); load(); }}
          user={user}
          salesmen={salesmen}
          defaultSalesmanId={topTab === "salesman" ? selectedSalesman : ""}
        />
      )}
      {editing && (
        <ExpenseEditor
          expense={editing}
          user={user}
          salesmen={salesmen}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
          onDelete={(e) => { setEditing(null); removeExpense(e); }}
        />
      )}
    </div>
  );
}

function ExpenseEditor({
  expense,
  user,
  salesmen,
  defaultSalesmanId = "",
  onClose,
  onSaved,
  onDelete,
}: {
  expense?: Expense;
  user: AppUser;
  salesmen: Seller[];
  // Logging from the Salesman tab with someone selected starts on that
  // person, rather than making the manager pick them twice.
  defaultSalesmanId?: string;
  onClose: () => void;
  onSaved: () => void;
  // Only an existing expense can be deleted, so this is absent when the
  // sheet is logging a new one. The list owns the removal — it owns the
  // rows it has to put back if the delete is refused.
  onDelete?: (expense: Expense) => void;
}) {
  const [type, setType] = useState<ExpenseType>(expense?.type ?? "fixed");
  const [category, setCategory] = useState(expense?.category ?? "");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount) : "");
  const [date, setDate] = useState(expense?.date ?? new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState(expense?.notes ?? "");
  const [salesmanId, setSalesmanId] = useState(expense?.salesman_id ?? defaultSalesmanId ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const payload = {
        type,
        category,
        description: description || null,
        amount: Number(amount),
        date,
        notes: notes || null,
        salesman_id: salesmanId || null,
      };
      if (expense) await updateExpense(supabaseBrowser(), expense.id, payload);
      else await createExpense(supabaseBrowser(), { ...payload, logged_by: user.id });
      onSaved();
    } catch (e) {
      // This used to throw into nothing: the sheet stayed open with no
      // explanation and the expense was not saved.
      toast.error(friendlyError(e, t("expense.saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={expense ? t("expense.editExpense") : t("expense.logExpense")}
      footer={
        <>
          {/* Deleting is a plain, unhighlighted action sitting away from
              Save, and it asks first — a mistyped expense should be
              removable, but not by a stray tap. */}
          {expense && onDelete && (
            <Button
              tier="plain"
              className="me-auto text-[--status-danger]"
              disabled={saving}
              onClick={() => {
                if (
                  confirm(
                    t("expense.confirmDelete", {
                      what: expense.category || expense.type,
                      amount: formatAed(expense.amount),
                    })
                  )
                ) {
                  onDelete(expense);
                }
              }}
            >
              {t("common.delete")}
            </Button>
          )}
          <Button tier="primary" disabled={saving || !type || !category || !amount || !date} onClick={save}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <Label>{t("expense.type")}</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={type}
        onChange={(e) => setType(e.target.value as ExpenseType)}
      >
        <option value="fixed">{t("expense.typeFixed")}</option>
        <option value="variable">{t("expense.typeVariable")}</option>
        <option value="purchase">{t("expense.typePurchase")}</option>
      </select>
      <Label>{t("expense.category")}</Label>
      <TextInput placeholder={t("expense.categoryPlaceholder")} value={category} onChange={(e) => setCategory(e.target.value)} />
      {/* Whose expense it is (§Expense: the Salesman view). Left blank for
          anything that belongs to the business rather than to a person. */}
      <Label>{t("expense.salesmanOptional")}</Label>
      <select
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead"
        value={salesmanId}
        onChange={(e) => setSalesmanId(e.target.value)}
      >
        <option value="">{t("expense.notForParticularSalesman")}</option>
        {salesmen.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
            {s.role === "salesman" ? "" : t("expense.roleSuffix", { role: s.role })}
          </option>
        ))}
      </select>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>{t("expense.amountAed")}</Label>
          <TextInput type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div>
          <Label>{t("expense.date")}</Label>
          <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <Label>{t("expense.descriptionOptional")}</Label>
      <TextInput value={description} onChange={(e) => setDescription(e.target.value)} />
      <Label>{t("expense.notesOptional")}</Label>
      <TextInput value={notes} onChange={(e) => setNotes(e.target.value)} />
    </Sheet>
  );
}
