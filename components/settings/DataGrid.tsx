"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search } from "lucide-react";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { formatAed } from "@/lib/money";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchCustomers,
  createCustomer,
  updateCustomer,
  nextCustomerCode,
} from "@/lib/queries/customers";
import { fetchProducts, createProduct, updateProduct } from "@/lib/queries/products";
import { fetchOrders, type OrderRow } from "@/lib/queries/orders";
import { DEFAULT_OVERDUE_DAYS } from "@/lib/queries/aging";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { CUSTOMER_ALIASES, PRODUCT_ALIASES, ORDER_ALIASES } from "@/lib/importAliases";
import { Skeleton } from "@/components/ui/Empty";
import type { AppUser, Customer, Product } from "@/lib/types/db";
import { t } from "@/lib/i18n";
import { CUSTOMER_SAMPLE_HEADERS, ORDER_SAMPLE_EXAMPLE, ORDER_SAMPLE_HEADERS, PRODUCT_SAMPLE_EXAMPLE, PRODUCT_SAMPLE_HEADERS, customerSampleExample } from "@/lib/importSamples";

// The phone's Manager Dashboard -> Data tab (ManagerDashboardView.swift,
// `DataTabView`) is a spreadsheet over the same four datasets the web only
// let you download: Customers, Articles, Orders and Users. Customers and
// Articles are editable cell by cell, take new rows, and take a CSV; Orders
// and Users are read-only there, and stay read-only here — an order is
// changed through the order screens, which apply the stock and invoice rules,
// and a user is changed in the Users tab, which is the one place that decides
// who may do what.
//
// Every write goes through the update path the rest of the app already uses
// (lib/queries/customers.ts, lib/queries/products.ts -> /api/products), so a
// cell edited here is validated and authorised exactly as the same edit made
// in the Customers or Products screen. There is deliberately no generic
// "update any table" endpoint behind this grid.
const KINDS = ["Customers", "Articles", "Orders", "Users"] as const;
type Kind = (typeof KINDS)[number];

// The chip label for each dataset. The value itself stays the data it always
// was — only what is shown moves into the catalogue.
const KIND_LABELS = {
  Customers: "nav.customers",
  Articles: "settings.articles",
  Orders: "nav.orders",
  Users: "settings.users",
} as const;

interface Column {
  key: string;
  label: string;
  width: number;
  // Right-aligned and set in tabular figures, so a column of quantities
  // lines up digit under digit.
  numeric?: boolean;
}

export default function DataGrid() {
  const [kind, setKind] = useState<Kind>("Customers");
  const [search, setSearch] = useState("");

  return (
    <div className="mt-6 pt-5 border-t border-hairline">
      <h3 className="text-subhead font-semibold mb-1">{t("settings.editDataInSheet")}</h3>
      <p className="text-caption text-secondary mb-3 max-w-[60ch]">
        {t("settings.dataGridHint")}
      </p>

      {/* The phone's chip bar. Horizontal on every width — four short labels
          never need to wrap. */}
      <div className="flex gap-1.5 overflow-x-auto mb-3 pb-0.5">
        {KINDS.map((k) => (
          <button
            key={k}
            onClick={() => {
              setKind(k);
              setSearch("");
            }}
            className={`whitespace-nowrap px-3.5 py-2.5 rounded-chip text-caption font-semibold border transition-colors ${
              kind === k
                ? "bg-accent text-white border-accent"
                : "border-hairline text-secondary hover:text-primary"
            }`}
          >
            {t(KIND_LABELS[k])}
          </button>
        ))}
      </div>

      <div className="relative mb-3 max-w-sm">
        <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("settings.searchKind", { kind: kind.toLowerCase() })}
          aria-label={t("settings.searchKind", { kind: kind.toLowerCase() })}
          className="w-full ps-9 pe-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
        />
      </div>

      {kind === "Customers" && <CustomersGrid search={search} />}
      {kind === "Articles" && <ArticlesGrid search={search} />}
      {kind === "Orders" && <OrdersGrid search={search} />}
      {kind === "Users" && <UsersGrid search={search} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

// The table scrolls inside its own box. A settings page that scrolls sideways
// because one column is wide is a page whose sidebar and headings move too.
function GridShell({
  columns,
  loading,
  rowCount,
  children,
}: {
  columns: Column[];
  loading: boolean;
  rowCount: number;
  children: React.ReactNode;
}) {
  const minWidth = columns.reduce((sum, c) => sum + c.width, 0);
  return (
    <div className="border border-hairline rounded-card overflow-hidden bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-caption" style={{ minWidth }}>
          <thead>
            <tr className="bg-canvas">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  style={{ minWidth: c.width }}
                  className={`font-semibold text-secondary px-3 py-2 border-b border-hairline whitespace-nowrap ${
                    c.numeric ? "text-end" : "text-start"
                  }`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              // Structured content, so it arrives as the shape it will have
              // rather than as a spinner over an empty box.
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-hairline last:border-b-0">
                  {columns.map((c) => (
                    <td key={c.key} className="px-3 py-1.5">
                      <Skeleton className="h-8 w-full" style={{ animationDelay: `${i * 90}ms` }} />
                    </td>
                  ))}
                </tr>
              ))
            ) : rowCount === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-3 py-8 text-center text-secondary">
                  {t("settings.noRowsYet")}
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActionBar({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-4 flex-wrap mb-3">{children}</div>;
}

function AddRowButton({ onClick, busy, label }: { onClick: () => void; busy: boolean; label: string }) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className="flex items-center gap-1.5 text-caption font-semibold text-secondary hover:text-accent disabled:opacity-50 min-h-[44px]"
    >
      <Plus size={14} /> {busy ? t("settings.adding") : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

// Buffers what is typed and only reports it on blur or Enter — the same
// reason the phone's `EditableCell` does (ManagerDashboardView.swift): a save
// on every keystroke republishes the whole list and takes the caret with it.
// Escape puts the cell back the way it was without saving.
//
// `onCommit` returning false means the edit was refused outright (an emptied
// name), and the cell goes back to what it held. A refusal that only arrives
// from the database later comes back a different way: the rolled-back row
// changes `value`, and the effect below picks it up.
function EditableCell({
  value,
  onCommit,
  numeric,
  label,
}: {
  value: string;
  onCommit: (next: string) => boolean | void;
  numeric?: boolean;
  label: string;
}) {
  const [local, setLocal] = useState(value);
  const [focused, setFocused] = useState(false);

  // A value that changed underneath us (a reload, or a rolled-back save)
  // replaces what is shown — unless the cell is being typed in, where it
  // would delete the edit mid-word.
  useEffect(() => {
    if (!focused) setLocal(value);
  }, [value, focused]);

  return (
    <input
      value={local}
      aria-label={label}
      inputMode={numeric ? "decimal" : undefined}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (local !== value && onCommit(local) === false) setLocal(value);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setLocal(value);
          setFocused(false);
          e.currentTarget.blur();
        }
      }}
      className={`w-full h-11 px-2 rounded-well bg-transparent text-caption hover:bg-accent/8 transition-colors ${
        numeric ? "text-end tabular-nums" : "text-start"
      }`}
    />
  );
}

function ReadOnlyCell({ children, numeric }: { children: React.ReactNode; numeric?: boolean }) {
  return (
    <td
      className={`px-3 py-3 whitespace-nowrap ${numeric ? "text-end tabular-nums" : "text-start"}`}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Shared edit plumbing
// ---------------------------------------------------------------------------

// Optimistic, with a real rollback: the row changes on screen first, and if
// the write is refused the old row goes back exactly as it was and the reason
// is said out loud. Nothing is left showing a value the database does not hold.
function useOptimisticRows<T extends { id: string }>() {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  // The row as it stands now, read outside the state updater so the updater
  // stays a pure function of the state it is handed.
  const rowsRef = useRef<T[]>([]);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  const patch = useCallback(
    async (id: string, changes: Partial<T>, save: () => Promise<unknown>, failMessage: string) => {
      const previous = rowsRef.current.find((r) => r.id === id);
      setRows((current) => current.map((r) => (r.id === id ? { ...r, ...changes } : r)));
      try {
        await save();
        return true;
      } catch (e) {
        if (previous) setRows((current) => current.map((r) => (r.id === id ? previous : r)));
        toast.error(friendlyError(e, failMessage));
        return false;
      }
    },
    []
  );

  return { rows, setRows, loading, setLoading, patch };
}

// A cell that must not be emptied — a customer without a name, an article
// without a code, is a row nobody can find again.
function required(next: string): string | null {
  const trimmed = next.trim();
  return trimmed === "" ? null : trimmed;
}

// "" means "nothing here", which is a null column, not an empty string.
function optional(next: string): string | null {
  const trimmed = next.trim();
  return trimmed === "" ? null : trimmed;
}

// Returns null when what was typed is not a number, so the caller can put the
// cell back rather than write NaN into a price.
function numberOrNull(next: string): number | null {
  const trimmed = next.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const CUSTOMER_COLUMNS: Column[] = [
  { key: "name", label: t("settings.colName"), width: 220 },
  { key: "code", label: t("settings.colCode"), width: 110 },
  { key: "district", label: t("settings.colDistrict"), width: 150 },
  { key: "address", label: t("settings.colAddress"), width: 260 },
];

function CustomersGrid({ search }: { search: string }) {
  const { rows, setRows, loading, setLoading, patch } = useOptimisticRows<Customer>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchCustomers(supabaseBrowser()));
    } catch (e) {
      toast.error(friendlyError(e, t("settings.couldntLoadCustomers")));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setRows]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.code ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  function edit(customer: Customer, field: "name" | "code" | "district" | "address", next: string) {
    const value = field === "name" || field === "code" ? required(next) : optional(next);
    if (value === null && (field === "name" || field === "code")) {
      toast.error(field === "name" ? t("settings.customerNeedsName") : t("settings.customerNeedsCode"));
      return false;
    }
    patch(
      customer.id,
      { [field]: value } as Partial<Customer>,
      () => updateCustomer(supabaseBrowser(), customer.id, { [field]: value }),
      t("settings.couldntSaveChange")
    );
    return true;
  }

  async function addRow() {
    setAdding(true);
    const supabase = supabaseBrowser();
    // The next number in the customer code series, the same rule the new-
    // customer form and the sample sheet use.
    let code: string;
    try {
      code = String(await nextCustomerCode(supabase));
    } catch (e) {
      setAdding(false);
      toast.error(friendlyError(e, t("settings.couldntWorkOutNextCode")));
      return;
    }
    const now = new Date().toISOString();
    const draft: Customer = {
      id: `pending-${now}`,
      code,
      name: "(new customer)",
      group_name: null,
      address: null,
      phone: null,
      district: null,
      vat_number: null,
      overdue_threshold_days: DEFAULT_OVERDUE_DAYS,
      is_active: true,
      created_at: now,
      updated_at: now,
      salesman_id: null,
    };
    setRows((current) => [draft, ...current]);
    try {
      await createCustomer(supabase, { code, name: draft.name, is_active: true });
      await load();
    } catch (e) {
      setRows((current) => current.filter((r) => r.id !== draft.id));
      toast.error(friendlyError(e, t("settings.couldntAddRow")));
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <ActionBar>
        <AddRowButton onClick={addRow} busy={adding} label={t("settings.addRow")} />
        <ImportCsvButton
          endpoint="/api/customers/import"
          onImported={load}
          aliases={CUSTOMER_ALIASES}
          sample={{
            // The same template the Customers screen hands out, so a sheet
            // filled in from either place uploads in either place.
            filename: "customers_import_template.csv",
            headers: CUSTOMER_SAMPLE_HEADERS,
            example: async () => customerSampleExample(String(await nextCustomerCode(supabaseBrowser()))),
          }}
        />
      </ActionBar>

      <GridShell columns={CUSTOMER_COLUMNS} loading={loading} rowCount={visible.length}>
        {visible.map((c) => (
          <tr key={c.id} className="border-b border-hairline last:border-b-0">
            <td className="px-1">
              <EditableCell
                label={t("settings.cellName", { code: c.code })}
                value={c.name}
                onCommit={(v) => edit(c, "name", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell label={t("settings.cellCode", { name: c.name })} value={c.code ?? ""} onCommit={(v) => edit(c, "code", v)} />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellDistrict", { name: c.name })}
                value={c.district ?? ""}
                onCommit={(v) => edit(c, "district", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellAddress", { name: c.name })}
                value={c.address ?? ""}
                onCommit={(v) => edit(c, "address", v)}
              />
            </td>
          </tr>
        ))}
      </GridShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Articles (products)
// ---------------------------------------------------------------------------

const ARTICLE_COLUMNS: Column[] = [
  { key: "sku", label: t("settings.colArticle"), width: 130 },
  { key: "name", label: t("settings.colDescription"), width: 240 },
  { key: "price", label: t("settings.colPrice"), width: 100, numeric: true },
  { key: "cost", label: t("settings.colCost"), width: 100, numeric: true },
  { key: "default_qty", label: t("settings.colDefaultQty"), width: 110, numeric: true },
  { key: "stock_on_hand", label: t("settings.colStock"), width: 100, numeric: true },
  { key: "rack_location", label: t("settings.colRack"), width: 100 },
  { key: "barcode", label: t("settings.colBarcode"), width: 160 },
];

type ArticleNumberField = "price" | "cost" | "default_qty" | "stock_on_hand";

// A second "(new article)" needs a code of its own — `sku` is the catalogue's
// unique key, and a repeat would be refused by the database rather than
// quietly saved.
function placeholderSku(existing: Product[]): string {
  const taken = new Set(existing.map((p) => p.sku.trim().toUpperCase()));
  if (!taken.has("NEW")) return "NEW";
  let n = 2;
  while (taken.has(`NEW-${n}`)) n++;
  return `NEW-${n}`;
}

function ArticlesGrid({ search }: { search: string }) {
  const { rows, setRows, loading, setLoading, patch } = useOptimisticRows<Product>();
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Inactive articles included: this is the sheet where a row that has
      // been switched off is still visible and still editable.
      setRows(await fetchProducts(supabaseBrowser(), { activeOnly: false }));
    } catch (e) {
      toast.error(friendlyError(e, t("settings.couldntLoadArticles")));
    } finally {
      setLoading(false);
    }
  }, [setLoading, setRows]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (p) => p.sku.toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  function editText(product: Product, field: "sku" | "name" | "rack_location" | "barcode", next: string) {
    const value = field === "sku" || field === "name" ? required(next) : optional(next);
    if (value === null && (field === "sku" || field === "name")) {
      toast.error(field === "sku" ? t("settings.articleNeedsCode") : t("settings.articleNeedsDescription"));
      return false;
    }
    patch(
      product.id,
      { [field]: value } as Partial<Product>,
      () => updateProduct(supabaseBrowser(), product.id, { [field]: value }),
      t("settings.couldntSaveChange")
    );
    return true;
  }

  function editNumber(product: Product, field: ArticleNumberField, next: string) {
    const value = numberOrNull(next);
    if (value === null && next.trim() !== "") {
      toast.error(t("settings.cellTakesNumber"));
      return false;
    }
    // `price` is not nullable — an empty price cell reads as nothing owed,
    // which is a number, not an absence.
    const resolved = field === "price" ? value ?? 0 : value;
    patch(
      product.id,
      { [field]: resolved } as Partial<Product>,
      () => updateProduct(supabaseBrowser(), product.id, { [field]: resolved }),
      t("settings.couldntSaveChange")
    );
    return true;
  }

  async function addRow() {
    setAdding(true);
    const sku = placeholderSku(rows);
    const draft: Product = {
      id: `pending-${Date.now()}`,
      sku,
      name: "(new article)",
      price: 0,
      cost: 0,
      // 12 is the catalogue's own default, the one the product editor and the
      // bulk import both use.
      default_qty: 12,
      barcode: null,
      rack_location: null,
      is_active: true,
      stock_on_hand: 0,
      category: null,
    };
    setRows((current) => [draft, ...current]);
    try {
      await createProduct(supabaseBrowser(), {
        sku,
        name: draft.name,
        price: 0,
        cost: 0,
        default_qty: 12,
        stock_on_hand: 0,
        is_active: true,
      });
      await load();
    } catch (e) {
      setRows((current) => current.filter((r) => r.id !== draft.id));
      toast.error(friendlyError(e, t("settings.couldntAddRow")));
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <ActionBar>
        <AddRowButton onClick={addRow} busy={adding} label={t("settings.addRow")} />
        <ImportCsvButton
          endpoint="/api/products/import"
          onImported={load}
          askStockMode
          aliases={PRODUCT_ALIASES}
          sample={{
            filename: "articles_import_template.csv",
            headers: PRODUCT_SAMPLE_HEADERS,
            example: PRODUCT_SAMPLE_EXAMPLE,
          }}
        />
      </ActionBar>

      <GridShell columns={ARTICLE_COLUMNS} loading={loading} rowCount={visible.length}>
        {visible.map((p) => (
          <tr key={p.id} className="border-b border-hairline last:border-b-0">
            <td className="px-1">
              <EditableCell label={t("settings.cellArticleCode", { name: p.name })} value={p.sku} onCommit={(v) => editText(p, "sku", v)} />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellDescription", { sku: p.sku })}
                value={p.name ?? ""}
                onCommit={(v) => editText(p, "name", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellPrice", { sku: p.sku })}
                numeric
                value={String(p.price ?? "")}
                onCommit={(v) => editNumber(p, "price", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellCost", { sku: p.sku })}
                numeric
                value={p.cost == null ? "" : String(p.cost)}
                onCommit={(v) => editNumber(p, "cost", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellDefaultQty", { sku: p.sku })}
                numeric
                value={p.default_qty == null ? "" : String(p.default_qty)}
                onCommit={(v) => editNumber(p, "default_qty", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellStock", { sku: p.sku })}
                numeric
                value={p.stock_on_hand == null ? "" : String(p.stock_on_hand)}
                onCommit={(v) => editNumber(p, "stock_on_hand", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellRack", { sku: p.sku })}
                value={p.rack_location ?? ""}
                onCommit={(v) => editText(p, "rack_location", v)}
              />
            </td>
            <td className="px-1">
              <EditableCell
                label={t("settings.cellBarcode", { sku: p.sku })}
                value={p.barcode ?? ""}
                onCommit={(v) => editText(p, "barcode", v)}
              />
            </td>
          </tr>
        ))}
      </GridShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orders (read-only, as on the phone)
// ---------------------------------------------------------------------------

const ORDER_COLUMNS: Column[] = [
  { key: "invoice", label: t("settings.colInvoice"), width: 130 },
  { key: "customer", label: t("settings.colCustomer"), width: 220 },
  { key: "salesman", label: t("nav.role.salesman"), width: 160 },
  { key: "total", label: t("common.total"), width: 130, numeric: true },
  { key: "status", label: t("settings.colStatus"), width: 120 },
];

function OrdersGrid({ search }: { search: string }) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchOrders(supabaseBrowser(), { limit: 500 }));
    } catch (e) {
      toast.error(friendlyError(e, t("settings.couldntLoadOrders")));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (o) =>
        (o.invoice_number ?? "").toLowerCase().includes(q) ||
        (o.salesman?.full_name ?? "").toLowerCase().includes(q) ||
        (o.customer?.name ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  return (
    <>
      <ActionBar>
        {/* The same importer the Orders screen uses — rows sharing an invoice
            become one order, and every one of them still arrives as pending
            for a manager to review. */}
        <ImportCsvButton
          endpoint="/api/orders/import"
          onImported={load}
          jobKind="orders.import"
          label={t("settings.importOrders")}
          unit="order"
          aliases={ORDER_ALIASES}
          sample={{
            filename: "orders_import_template.csv",
            headers: ORDER_SAMPLE_HEADERS,
            example: ORDER_SAMPLE_EXAMPLE,
          }}
        />
      </ActionBar>

      <GridShell columns={ORDER_COLUMNS} loading={loading} rowCount={visible.length}>
        {visible.map((o) => (
          <tr key={o.id} className="border-b border-hairline last:border-b-0">
            <ReadOnlyCell>
              <span className="tabular-nums">{o.invoice_number ?? t("common.notSet")}</span>
            </ReadOnlyCell>
            <ReadOnlyCell>{o.customer?.name ?? o.new_customer_note ?? t("common.notSet")}</ReadOnlyCell>
            <ReadOnlyCell>{o.salesman?.full_name ?? t("common.notSet")}</ReadOnlyCell>
            <ReadOnlyCell numeric>{o.total == null ? t("common.notSet") : formatAed(o.total)}</ReadOnlyCell>
            <ReadOnlyCell>{o.status}</ReadOnlyCell>
          </tr>
        ))}
      </GridShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Users (read-only, as on the phone)
// ---------------------------------------------------------------------------

const USER_COLUMNS: Column[] = [
  { key: "username", label: t("settings.username"), width: 150 },
  { key: "full_name", label: t("settings.fullName"), width: 200 },
  { key: "role", label: t("settings.role"), width: 120 },
  { key: "email", label: t("settings.email"), width: 240 },
];

function UsersGrid({ search }: { search: string }) {
  const [rows, setRows] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabaseBrowser()
        .from("users")
        .select("id, auth_user_id, username, full_name, role, email, is_active, created_at, updated_at")
        .order("full_name");
      if (cancelled) return;
      if (error) toast.error(friendlyError(error, t("settings.couldntLoadUsers")));
      setRows((data as AppUser[]) ?? []);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (u) =>
        (u.username ?? "").toLowerCase().includes(q) ||
        (u.full_name ?? "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  return (
    <>
      <p className="text-caption text-secondary mb-3 max-w-[60ch]">
        {t("settings.usersGridHint")}
      </p>
      <GridShell columns={USER_COLUMNS} loading={loading} rowCount={visible.length}>
        {visible.map((u) => (
          <tr key={u.id} className="border-b border-hairline last:border-b-0">
            <ReadOnlyCell>@{u.username}</ReadOnlyCell>
            <ReadOnlyCell>{u.full_name}</ReadOnlyCell>
            <ReadOnlyCell>{u.role}</ReadOnlyCell>
            <ReadOnlyCell>{u.email ?? t("common.notSet")}</ReadOnlyCell>
          </tr>
        ))}
      </GridShell>
    </>
  );
}
