"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Plus, FileText, ChevronDown, ChevronRight, Search, SlidersHorizontal, PackageCheck, Trash2, XCircle, CalendarDays } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchOrders,
  resubmitOrder,
  deleteOrder,
  fetchOrdersPage,
  countOrders,
  fetchTrashedOrders,
  restoreOrder,
  purgeOrder,
  type OrderRow,
  type OrderCursor,
  type TrashedOrderRow,
} from "@/lib/queries/orders";
import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import { friendlyError } from "@/lib/errors";
import {
  countOrdersThisMonth,
  monthBounds,
  orderItemCounts,
  grossProfitByOrder,
  gpPercent,
  type GrossProfit,
} from "@/lib/queries/dashboard";
import { fetchPaidByOrder } from "@/lib/queries/aging";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import type { AppUser, OrderStatus } from "@/lib/types/db";
import Button from "@/components/ui/Button";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import { Card } from "@/components/ui/Card";
import { RingProgress } from "@/components/ui/charts";
import ScrollAwayTabs from "@/components/ui/ScrollAwayTabs";
import { BILLED_STATUSES } from "@/lib/billedStatuses";
import { EmptyState, Skeleton, SkeletonList } from "@/components/ui/Empty";
import { StaggerList } from "@/components/ui/StaggerList";
import { OrderStatusPill, Pill } from "@/components/ui/Badge";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { formatAed, toAed, toFils } from "@/lib/money";
import NewOrderSheet from "./NewOrderSheet";
import OrderDetail from "./OrderDetail";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { ORDER_ALIASES } from "@/lib/importAliases";
import { ORDER_SAMPLE_EXAMPLE, ORDER_SAMPLE_HEADERS } from "@/lib/importSamples";

// Orders Adjust View (§Next Updates: "Adjust View option in the all orders
// subtab"; owner, 2026-10-06: "make proper adjust view for the orders page,
// similar to the customers adjust view, but I want GP"). Date, invoice,
// customer and status are the fixed identity+status columns; the money
// columns and the district are individually toggleable, with a few named
// views on top — the Customers popover's shape. GP is a manager's column:
// nobody else is shown cost, so nobody else is offered it.
// gpPct is not offered in the popover: it is GP % as a column of its own,
// drawn only by the This month view (below).
type OrderColumnKey = "amount" | "received" | "balance" | "gp" | "gpPct" | "district";
const ALL_ORDER_COLUMNS: OrderColumnKey[] = ["amount", "received", "balance", "gp", "district"];
const ORDER_COLUMN_LABELS: Record<OrderColumnKey, string> = {
  amount: t("orders.amount"),
  received: t("orders.received"),
  balance: t("orders.balance"),
  gp: t("orders.gp"),
  gpPct: t("orders.gpPct"),
  district: t("orders.district"),
};
// Default is the table as it has always been drawn on a computer.
const ORDER_VIEWS: { key: string; label: string; columns: OrderColumnKey[]; managerOnly?: boolean }[] = [
  { key: "default", label: t("orders.viewDefault"), columns: ["amount", "received", "balance"] },
  { key: "profit", label: t("orders.viewProfit"), columns: ["amount", "gp", "balance"], managerOnly: true },
  { key: "compact", label: t("orders.viewCompact"), columns: [] },
  { key: "all", label: t("orders.viewAllColumns"), columns: ALL_ORDER_COLUMNS },
];

// The columns every list on the page draws, so Section /
// PaginatedOrderSection / OrderList need not pass them one prop at a time.
const OrderColumnsContext = createContext<OrderColumnKey[]>(ORDER_VIEWS[0].columns);

function sameColumns(a: OrderColumnKey[], b: OrderColumnKey[]): boolean {
  return a.length === b.length && a.every((c) => b.includes(c));
}

function OrdersAdjustViewPopover({
  views,
  columns,
  activeColumns,
  onSelectView,
  onToggleColumn,
}: {
  views: typeof ORDER_VIEWS;
  columns: OrderColumnKey[];
  activeColumns: OrderColumnKey[];
  onSelectView: (view: (typeof ORDER_VIEWS)[number]) => void;
  onToggleColumn: (col: OrderColumnKey) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="p-2.5 rounded-full border border-hairline text-secondary hover:text-accent"
        aria-label={t("orders.adjustView")}
        title={t("orders.adjustView")}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute end-0 mt-2 w-64 glass rounded-card shadow-floating z-20 p-3">
            <div className="text-caption text-secondary font-semibold mb-1.5">{t("orders.defaultViews")}</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {views.map((v) => (
                <button
                  key={v.key}
                  onClick={() => onSelectView(v)}
                  aria-pressed={sameColumns(v.columns, activeColumns)}
                  className={`px-2.5 py-1 rounded-card text-caption font-medium border ${
                    sameColumns(v.columns, activeColumns) ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="text-caption text-secondary font-semibold mb-1.5">{t("orders.columns")}</div>
            {columns.map((col) => (
              <label key={col} className="flex items-center gap-2 py-1 text-subhead">
                <input type="checkbox" checked={activeColumns.includes(col)} onChange={() => onToggleColumn(col)} />
                {ORDER_COLUMN_LABELS[col]}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Sorting the list. The previous version of this app had exactly these seven
// orderings and people work from them — an accounts query starts with the
// biggest invoice, a chase starts with the oldest.
const ORDER_SORTS = [
  { key: "newest", label: t("orders.sortNewestFirst") },
  { key: "oldest", label: t("orders.sortOldestFirst") },
  { key: "invoice_desc", label: t("orders.sortInvoiceHighToLow") },
  { key: "invoice_asc", label: t("orders.sortInvoiceLowToHigh") },
  { key: "total_desc", label: t("orders.sortAmountHighToLow") },
  { key: "total_asc", label: t("orders.sortAmountLowToHigh") },
  { key: "salesman", label: t("orders.sortSalesman") },
] as const;
type OrderSort = (typeof ORDER_SORTS)[number]["key"];

// Invoice numbers are text in the database, so "9" must not sort above "10".
function invoiceValue(o: OrderRow): number {
  const digits = (o.invoice_number ?? "").replace(/^INV-?/i, "").match(/\d+/);
  return digits ? Number(digits[0]) : -1;
}

// The date an order is listed and sorted by: its billing date (owner,
// 2026-09-22), the same date it counts on in sales and the one on its invoice.
// Every row from lib/queries/orders.ts carries billed_at; updated_at is the
// belt-and-braces for a row that somehow does not.
function listDate(o: OrderRow): number {
  return +new Date(o.billed_at ?? o.updated_at);
}

function sortOrders(rows: OrderRow[], sort: OrderSort): OrderRow[] {
  const out = [...rows];
  switch (sort) {
    case "oldest":
      return out.sort((a, b) => listDate(a) - listDate(b));
    case "invoice_desc":
      return out.sort((a, b) => invoiceValue(b) - invoiceValue(a));
    case "invoice_asc":
      // Orders with no number yet belong at the end, not ahead of invoice 1.
      return out.sort((a, b) => {
        const av = invoiceValue(a);
        const bv = invoiceValue(b);
        if (av < 0 && bv < 0) return 0;
        if (av < 0) return 1;
        if (bv < 0) return -1;
        return av - bv;
      });
    case "total_desc":
      return out.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    case "total_asc":
      return out.sort((a, b) => (a.total ?? 0) - (b.total ?? 0));
    case "salesman":
      return out.sort((a, b) =>
        (a.salesman?.full_name ?? "").localeCompare(b.salesman?.full_name ?? "")
      );
    default:
      return out.sort((a, b) => listDate(b) - listDate(a));
  }
}

const PIPELINE: OrderStatus[] = [
  "accepted",
  "waiting",
  "picking",
  "packed",
  "edit_requested",
];

// §Orders summary mockup: Warehouse is a single block whose stages sit
// inline as pills inside it (Waiting / Picking / Packed) — picking a stage IS
// the navigation, so there's no second sub-nav row underneath. The
// warehouse's part ends at Packed: approval makes the order an invoice, and
// there is no delivery step after it (owner, 2026-09-27).
const WAREHOUSE_STAGES = ["waiting", "picking", "packed"] as const;
type WarehouseStage = (typeof WAREHOUSE_STAGES)[number];

// The stage a link can ask this page to open on (`?stage=packed`).
// Anything the parameter holds that is not a stage is ignored.
function stageFromParam(value: string | null): WarehouseStage | null {
  return WAREHOUSE_STAGES.includes(value as WarehouseStage) ? (value as WarehouseStage) : null;
}
const WAREHOUSE_STAGE_LABEL: Record<WarehouseStage, string> = {
  waiting: t("orders.stageWaiting"),
  picking: t("orders.stagePicking"),
  packed: t("orders.stagePacked"),
};

export default function OrdersView({ user }: { user: AppUser }) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [monthCount, setMonthCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("");
  // Search (§Next Updates: "Search Option in all subtabs") — filters by
  // customer name or invoice number, applied regardless of which subtab is
  // active so it works everywhere the request asked for.
  const [search, setSearch] = useState("");
  // What the paged Approved / Past list asks the database for — a moment
  // after typing stops, not once per keystroke.
  const [serverSearch, setServerSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setServerSearch(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const [sort, setSort] = useState<OrderSort>("newest");
  const { preferences, update: updatePrefs } = usePreferences();
  // Manager's Orders/New Orders/Warehouse switcher (§1.3) — the other roles
  // keep their existing bucketed views untouched.
  // A stage asked for in the URL opens on it.
  const searchParams = useSearchParams();
  const requestedStage = stageFromParam(searchParams.get("stage"));
  // "month" is the orders billed this month — the ring's own view (owner,
  // 2026-10-06: clicking the progress circle filters the orders to this month).
  const [managerView, setManagerView] = useState<"new" | "rejected" | "warehouse" | "all" | "month">(
    requestedStage ? "warehouse" : "new"
  );
  const [warehouseStage, setWarehouseStage] = useState<WarehouseStage>(requestedStage ?? "waiting");
  // Bumped whenever a "orders" Realtime event fires — PaginatedOrderSection
  // watches this instead of subscribing itself: two useRealtimeTable("orders")
  // calls with no filter would collide on the same channel name.
  const [refreshKey, setRefreshKey] = useState(0);
  // Multi-select (manager and admin). While it is on, tapping a row ticks it
  // instead of opening it, in every list on the page. One bulk action:
  // Delete — the same delete as the order's own, once per ticked order.
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const selection = useMemo<OrderSelection | null>(
    () =>
      selecting
        ? {
            ids: selectedIds,
            toggle: (id) =>
              setSelectedIds((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              }),
          }
        : null,
    [selecting, selectedIds]
  );
  function stopSelecting() {
    setSelecting(false);
    setSelectedIds(new Set());
  }

  // WIP pipeline is naturally small/bounded (this is the fetch), unlike the
  // Approved / Past-Orders archives which grow forever — those go through
  // <PaginatedOrderSection> (real cursor pagination, §0.4/§0.7) below
  // instead of being pulled into this array.
  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const salesmanId = user.role === "salesman" ? user.id : undefined;
    const [rows, count, mCount] = await Promise.all([
      fetchOrders(supabase, { salesmanId, excludeStatus: BILLED_STATUSES, limit: 300 }),
      countOrders(supabase, { salesmanId }),
      countOrdersThisMonth(supabase, salesmanId),
    ]);
    setOrders(rows);
    setTotalCount(count);
    setMonthCount(mCount);
    setLoading(false);
  }, [user]);

  useEffect(() => {
    load();
  }, [load]);

  // One at a time, through the same route as a single delete, so each order
  // gets its stock put back and its payments released exactly as it would
  // alone — and one refusal does not stop the rest.
  async function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirm(t("orders.deleteSelectedConfirm", { n: ids.length }))) return;
    setBulkBusy(true);
    let failed = 0;
    for (const id of ids) {
      try {
        await deleteOrder(id);
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    const done = ids.length - failed;
    if (done > 0) toast.success(t("orders.deletedSelected", { n: done }));
    if (failed > 0) toast.error(t("orders.deleteSelectedFailed", { n: failed }));
    stopSelecting();
    await load();
    setRefreshKey((k) => k + 1);
  }

  useRealtimeTable("orders", () => {
    load();
    setRefreshKey((k) => k + 1);
  });

  interface Sections {
    drafts?: OrderRow[];
    pending?: OrderRow[];
    past?: OrderRow[]; // WIP-only — approved orders are paginated separately below
    rejected?: OrderRow[];
    queue?: OrderRow[];
    pipeline?: OrderRow[];
    other?: OrderRow[];
  }

  const isManager = (user.role === "manager" || user.role === "admin");

  // What the Adjust View offers this person, and what they have chosen. GP
  // is taken out for anyone but a manager, whatever their saved choice says.
  const offeredColumns = isManager ? ALL_ORDER_COLUMNS : ALL_ORDER_COLUMNS.filter((c) => c !== "gp");
  const offeredViews = ORDER_VIEWS.filter((v) => isManager || !v.managerOnly).map((v) => ({
    ...v,
    columns: v.columns.filter((c) => offeredColumns.includes(c)),
  }));
  const chosenView = offeredViews.find((v) => v.key === preferences.orderListView) ?? offeredViews[0];
  // Before this popover had views, its only lasting choice was District;
  // that carries over until a new choice is saved.
  const savedColumns =
    (preferences.orderListColumns as OrderColumnKey[] | undefined) ??
    (preferences.ordersColumns?.includes("district") ? [...chosenView.columns, "district"] : chosenView.columns);
  const activeOrderColumns = offeredColumns.filter((c) => savedColumns.includes(c));

  // Coming from the nav while this page is already open does not remount it,
  // so the stage named in the URL is followed whenever it changes.
  useEffect(() => {
    if (!requestedStage) return;
    setWarehouseStage(requestedStage);
    if (isManager) setManagerView("warehouse");
  }, [requestedStage, isManager]);

  const searchedOrders = useMemo(() => {
    const term = search.trim().toLowerCase();
    const matched = !term
      ? orders
      : orders.filter((o) => {
          const name = (o.customer?.name ?? o.new_customer_note ?? "").toLowerCase();
          const invoice = (o.invoice_number ?? "").toLowerCase();
          return name.includes(term) || invoice.includes(term);
        });
    return sortOrders(matched, sort);
  }, [orders, search, sort]);

  const sections: Sections = useMemo(() => {
    if (user.role === "salesman") {
      return {
        drafts: searchedOrders.filter((o) => o.status === "draft"),
        pending: searchedOrders.filter((o) => o.status === "pending"),
        past: searchedOrders.filter((o) => !["draft", "pending", "rejected", "cancelled"].includes(o.status)),
        rejected: searchedOrders.filter((o) => o.status === "rejected"),
      };
    }
    if (user.role === "warehouse") {
      return {
        queue: searchedOrders.filter((o) => PIPELINE.includes(o.status)),
      };
    }
    // manager, "all" sub-tab
    const filtered = statusFilter ? searchedOrders.filter((o) => o.status === statusFilter) : searchedOrders;
    return {
      pending: filtered.filter((o) => o.status === "pending"),
      pipeline: filtered.filter((o) => PIPELINE.includes(o.status)),
      rejected: filtered.filter((o) => o.status === "rejected"),
      other: filtered.filter(
        (o) =>
          !["pending", "rejected", "draft", ...BILLED_STATUSES].includes(o.status) &&
          !PIPELINE.includes(o.status)
      ),
    };
  }, [searchedOrders, user.role, statusFilter]);

  const switcherStats = useMemo(() => {
    if (!isManager) return null;
    const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
    // "accepted" is the pre-picking state the warehouse still sees as
    // Waiting, so it's folded into that stage's count (and its rows below).
    const stageCounts = {
      waiting: orders.filter((o) => ["waiting", "accepted"].includes(o.status)).length,
      picking: count("picking"),
      packed: count("packed"),
    } satisfies Record<WarehouseStage, number>;
    // What each stage's orders are worth — the order total, as every order
    // row shows it — and all three together as the Potential total: the
    // sales still on their way through the warehouse (owner, 2026-10-06).
    // Summed in fils so a float artefact can't creep into the figure.
    const stageFils = (stage: WarehouseStage) =>
      orders
        .filter((o) => (stage === "waiting" ? ["waiting", "accepted"].includes(o.status) : o.status === stage))
        .reduce((sum, o) => sum + toFils(Number(o.total ?? 0)), 0);
    const stageValueFils = {
      waiting: stageFils("waiting"),
      picking: stageFils("picking"),
      packed: stageFils("packed"),
    } satisfies Record<WarehouseStage, number>;
    return {
      newOrders: count("pending"),
      rejected: count("rejected"),
      stageCounts,
      stageValues: {
        waiting: toAed(stageValueFils.waiting),
        picking: toAed(stageValueFils.picking),
        packed: toAed(stageValueFils.packed),
      } satisfies Record<WarehouseStage, number>,
      potentialTotal: toAed(Object.values(stageValueFils).reduce((a, b) => a + b, 0)),
      warehouseCount: Object.values(stageCounts).reduce((a, b) => a + b, 0),
      all: totalCount,
      thisMonth: monthCount,
    };
  }, [orders, isManager, totalCount, monthCount]);

  // Not taken from `sections`: that one honours the All Orders status filter,
  // which would quietly empty this view.
  const rejectedRows = useMemo(() => searchedOrders.filter((o) => o.status === "rejected"), [searchedOrders]);

  // The manager has always been able to step through the warehouse stages.
  // The warehouse itself could not: it saw one flat queue mixing orders not yet
  // started with ones half-picked and ones already packed, which is the wrong
  // shape for the person actually doing the work.
  const isWarehouse = user.role === "warehouse";
  const showsWarehouseStages = isWarehouse;
  // A manager's search covers every order, whichever tab is open (owner,
  // 2026-10-06: searching 4503 from New orders found nothing, because that
  // tab only holds orders waiting for review). Clearing the search, or
  // picking a tab, goes back to the tab.
  const shownView = isManager && search.trim() ? "all" : managerView;
  function pickView(view: typeof managerView) {
    setManagerView(view);
    setSearch("");
  }

  const warehouseRows = useMemo(() => {
    if (!isManager && !showsWarehouseStages) return [];
    // "Accepted" is an order that has reached the warehouse but nobody has
    // picked yet, so it belongs under Waiting rather than in a stage of its own.
    if (warehouseStage === "waiting") return searchedOrders.filter((o) => ["waiting", "accepted"].includes(o.status));
    return searchedOrders.filter((o) => o.status === warehouseStage);
  }, [searchedOrders, isManager, showsWarehouseStages, warehouseStage]);

  // Counts sit on the tabs so the warehouse can see where the work is without
  // opening each one.
  const warehouseStageCounts = useMemo(() => {
    const count = (stage: WarehouseStage) => {
      if (stage === "waiting") {
        return searchedOrders.filter((o) => ["waiting", "accepted"].includes(o.status)).length;
      }
      return searchedOrders.filter((o) => o.status === stage).length;
    };
    return Object.fromEntries(WAREHOUSE_STAGES.map((st) => [st, count(st)])) as Record<WarehouseStage, number>;
  }, [searchedOrders]);

  if (loading) return <SkeletonList rows={6} />;

  return (
    <OrderSelectionContext.Provider value={selection}>
    <OrderColumnsContext.Provider value={activeOrderColumns}>
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">
          {t("nav.orders")}
        </h1>
        <div className="flex items-center gap-4 flex-wrap">
          {/* A day's orders taken on paper or in a supplier's sheet, brought
              in as whole orders for review rather than typed again. */}
          {isManager && (
            <ImportCsvButton
              endpoint="/api/orders/import"
              onImported={load}
              jobKind="orders.import"
              label={t("orders.importOrders")}
              unit="order"
              aliases={ORDER_ALIASES}
              sample={{
                filename: "orders_sample.csv",
                headers: ORDER_SAMPLE_HEADERS,
            example: ORDER_SAMPLE_EXAMPLE,
              }}
            />
          )}
          {user.role !== "warehouse" && (
            <Button tier="primary" onClick={() => setShowNew(true)} className="flex items-center gap-1.5">
              <Plus size={16} /> {t("orders.newOrder")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("orders.searchByCustomerOrInvoice")}
            className="w-full ps-9 pe-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as OrderSort)}
          aria-label={t("orders.sortOrders")}
          className="px-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
        >
          {ORDER_SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
        <OrdersAdjustViewPopover
          views={offeredViews}
          columns={offeredColumns}
          activeColumns={activeOrderColumns}
          onSelectView={(v) => updatePrefs({ orderListView: v.key, orderListColumns: v.columns })}
          onToggleColumn={(col) =>
            updatePrefs({
              orderListColumns: activeOrderColumns.includes(col)
                ? activeOrderColumns.filter((c) => c !== col)
                : [...activeOrderColumns, col],
            })
          }
        />
        {isManager &&
          (selecting ? (
            <div className="flex items-center gap-2 ms-auto">
              <span className="text-caption text-secondary tabular-nums">
                {t("orders.selectedCount", { n: selectedIds.size })}
              </span>
              <Button
                tier="plain"
                disabled={bulkBusy || selectedIds.size === 0}
                className="text-[--status-danger] flex items-center gap-1.5"
                onClick={deleteSelected}
              >
                <Trash2 size={15} /> {bulkBusy ? t("orders.deletingSelected") : t("common.delete")}
              </Button>
              <Button tier="plain" disabled={bulkBusy} onClick={stopSelecting}>
                {t("common.done")}
              </Button>
            </div>
          ) : (
            <Button tier="plain" className="ms-auto" onClick={() => setSelecting(true)}>
              {t("orders.select")}
            </Button>
          ))}
      </div>

      {switcherStats && (
        <ScrollAwayTabs>
          <Card className="p-4 mb-5">
            <div className="flex items-start gap-5 flex-wrap">
              {/* The ring is the "This month" option: clicking it lists the
                  orders billed this month (owner, 2026-10-06). */}
              <button
                type="button"
                onClick={() => pickView("month")}
                aria-pressed={shownView === "month"}
                aria-label={t("orders.thisMonthSwitch")}
                className={`flex flex-col items-center gap-1.5 shrink-0 p-1 -m-1 rounded-card transition-colors ${
                  shownView === "month" ? "bg-accent/[0.08]" : "hover:bg-black/5 dark:hover:bg-white/10"
                }`}
              >
                <RingProgress
                  value={switcherStats.newOrders}
                  max={Math.max(1, switcherStats.all)}
                  label={String(switcherStats.newOrders)}
                />
                <span className="text-caption font-semibold text-secondary">{t("orders.pending")}</span>
              </button>

              <div className="flex-1 min-w-[220px] flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <SwitchButton
                    label={t("orders.newOrdersSwitch")}
                    count={switcherStats.newOrders}
                    active={shownView === "new"}
                    onClick={() => pickView("new")}
                  />
                  <SwitchButton
                    label={t("orders.rejectedSwitch")}
                    count={switcherStats.rejected}
                    active={shownView === "rejected"}
                    onClick={() => pickView("rejected")}
                  />
                  <SwitchButton
                    label={t("orders.allOrdersSwitch")}
                    count={switcherStats.all}
                    active={shownView === "all"}
                    onClick={() => pickView("all")}
                  />
                  <span className="ms-auto">
                    <SwitchButton
                      label={t("orders.thisMonthSwitch")}
                      count={switcherStats.thisMonth}
                      active={shownView === "month"}
                      onClick={() => pickView("month")}
                    />
                  </span>
                </div>

                <div
                  className={`rounded-card border p-3 transition-colors ${
                    shownView === "warehouse" ? "border-accent/40 bg-accent/[0.04]" : "border-hairline"
                  }`}
                >
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-subhead font-semibold">{t("nav.role.warehouse")}</span>
                    <span className="text-caption text-secondary tabular-nums">{switcherStats.warehouseCount}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {WAREHOUSE_STAGES.map((stage) => {
                      const isActive = shownView === "warehouse" && warehouseStage === stage;
                      return (
                        <button
                          key={stage}
                          onClick={() => {
                            pickView("warehouse");
                            setWarehouseStage(stage);
                          }}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-card text-caption font-semibold border transition-colors ${
                            isActive
                              ? "bg-accent text-white border-accent"
                              : "border-hairline text-secondary hover:text-primary"
                          }`}
                        >
                          {WAREHOUSE_STAGE_LABEL[stage]}
                          <span
                            className={`tabular-nums px-1.5 py-0.5 rounded-full ${
                              isActive ? "bg-white/20" : "bg-black/5 dark:bg-white/10"
                            }`}
                          >
                            {switcherStats.stageCounts[stage]}
                          </span>
                        </button>
                      );
                    })}
                    {/* Each stage's value, then the three together at the
                        edge (owner, 2026-10-06). */}
                    <div className="ms-auto flex items-end gap-5 flex-wrap">
                      {WAREHOUSE_STAGES.map((stage) => (
                        <div key={stage} className="flex flex-col items-end">
                          <span className="text-caption text-secondary">{WAREHOUSE_STAGE_LABEL[stage]}</span>
                          <span className="text-caption font-semibold tabular-nums">
                            {formatAed(switcherStats.stageValues[stage])}
                          </span>
                        </div>
                      ))}
                      <div className="flex flex-col items-end ps-5 border-s border-hairline">
                        <span className="text-caption text-secondary">{t("orders.potentialTotal")}</span>
                        <span className="text-subhead font-semibold tabular-nums">
                          {formatAed(switcherStats.potentialTotal)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </ScrollAwayTabs>
      )}

      {isManager && shownView === "new" && (
        <Section title={t("orders.newOrdersToReview")} rows={sections.pending ?? []} onOpen={setOpenId} />
      )}
      {/* Every rejected order in one place (owner, 2026-10-03), rather than
          only at the foot of All Orders or folded into the Trash — both of
          those stay as they were. Rejected orders are purged after 30 days,
          so the list stays short; opening one gives the usual resubmit. */}
      {isManager && shownView === "rejected" && (
        rejectedRows.length > 0 ? (
          <Section title={t("orders.rejected")} rows={rejectedRows} onOpen={setOpenId} />
        ) : (
          <EmptyState icon={XCircle} title={t("orders.noRejectedOrders")} />
        )
      )}
      {isManager && shownView === "warehouse" && (
        <Section title={WAREHOUSE_STAGE_LABEL[warehouseStage]} rows={warehouseRows} onOpen={setOpenId} />
      )}
      {/* The orders billed this month — the same orders the switcher's
          "This month" figure counts, by billing date (owner, 2026-10-06). */}
      {/* Its money columns are GP and GP % rather than Received and
          Balance (owner, 2026-10-06); District still follows the Adjust
          View. Manager-only, as GP is. */}
      {isManager && shownView === "month" && (
        <OrderColumnsContext.Provider
          value={["amount", "gp", "gpPct", ...activeOrderColumns.filter((c) => c === "district")]}
        >
        <PaginatedOrderSection
          title={t("orders.thisMonthSwitch")}
          statusOnly={BILLED_STATUSES}
          billedWindow={monthBounds()}
          onOpen={setOpenId}
          refreshKey={refreshKey}
         
          sort={sort}
          empty={<EmptyState icon={CalendarDays} title={t("orders.noOrdersThisMonth")} />}
        />
        </OrderColumnsContext.Provider>
      )}

      {showsWarehouseStages && (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {WAREHOUSE_STAGES.map((stage) => {
              const isActive = warehouseStage === stage;
              return (
                <button
                  key={stage}
                  onClick={() => setWarehouseStage(stage)}
                  aria-pressed={isActive}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-card text-caption font-semibold border transition-colors ${
                    isActive
                      ? "bg-accent text-white border-accent"
                      : "border-hairline text-secondary hover:text-primary"
                  }`}
                >
                  {WAREHOUSE_STAGE_LABEL[stage]}
                  <span
                    className={`tabular-nums px-1.5 py-0.5 rounded-full ${
                      isActive ? "bg-white/20" : "bg-black/5 dark:bg-white/10"
                    }`}
                  >
                    {warehouseStageCounts[stage]}
                  </span>
                </button>
              );
            })}
          </div>
          {warehouseRows.length > 0 ? (
            <Section title={WAREHOUSE_STAGE_LABEL[warehouseStage]} rows={warehouseRows} onOpen={setOpenId} />
          ) : (
            // Section renders nothing at all when it has no rows, which on a
            // stage tab leaves the page blank and looks like a failure rather
            // than an empty stage.
            <EmptyState
              icon={PackageCheck}
              title={t("orders.nothingInStageRightNow", {
                stage: WAREHOUSE_STAGE_LABEL[warehouseStage].toLowerCase(),
              })}
            />
          )}
        </>
      )}

      {(!isManager || shownView === "all") && !showsWarehouseStages && (
        <>
          {isManager && (
            <div className="mb-4 flex items-center gap-2">
              <select
                className="px-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">{t("orders.allStatuses")}</option>
                {["pending", "waiting", "picking", "packed", "approved", "edit_requested", "rejected", "cancelled"].map(
                  (s) => (
                    <option key={s} value={s}>{s}</option>
                  )
                )}
              </select>
            </div>
          )}

          {sections.drafts && sections.drafts.length > 0 && (
            <div className="mb-4">
              <button
                className="flex items-center gap-1.5 text-subhead font-semibold mb-2"
                onClick={() => setDraftsOpen((v) => !v)}
              >
                {draftsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                {t("orders.drafts")}
                <span className="px-2 py-0.5 rounded-full bg-warning/20 text-[--status-warning] text-caption font-bold">
                  {sections.drafts.length}
                </span>
              </button>
              {draftsOpen && <OrderList rows={sections.drafts} onOpen={setOpenId} />}
            </div>
          )}

          {sections.pending && !isManager && (
            <Section title={t("orders.pending")} rows={sections.pending} onOpen={setOpenId} />
          )}
          {isManager && sections.pending && (
            <Section title={t("orders.newOrdersToReview")} rows={sections.pending} onOpen={setOpenId} />
          )}
          {sections.pipeline && <Section title={t("orders.inProgress")} rows={sections.pipeline} onOpen={setOpenId} />}
          {sections.queue && <Section title={t("orders.queue")} rows={sections.queue} onOpen={setOpenId} />}
          {sections.past && sections.past.length > 0 && <Section title={t("orders.past")} rows={sections.past} onOpen={setOpenId} />}
          {user.role === "salesman" && (
            <PaginatedOrderSection
              title={sections.past && sections.past.length > 0 ? undefined : t("orders.past")}
              statusOnly={BILLED_STATUSES}
              salesmanId={user.id}
              onOpen={setOpenId}
              refreshKey={refreshKey}
              search={serverSearch}
              sort={sort}
            />
          )}
          {isManager && (!statusFilter || statusFilter === "approved") && (
            <PaginatedOrderSection
              title={t("orders.approved")}
              statusOnly={BILLED_STATUSES}
              onOpen={setOpenId}
              refreshKey={refreshKey}
              search={serverSearch}
             
              sort={sort}
            />
          )}
          {sections.other && sections.other.length > 0 && <Section title={t("orders.other")} rows={sections.other} onOpen={setOpenId} />}
          {sections.rejected && <Section title={t("orders.rejected")} rows={sections.rejected} onOpen={setOpenId} />}
        </>
      )}

      <TrashSection user={user} refreshKey={refreshKey} onChanged={load} />

      <PageFooterActions>
        {(user.role === "manager" || user.role === "admin") && <ExportLink type="orders" />}
      </PageFooterActions>

      {showNew && (
        <NewOrderSheet
          user={user}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            setShowNew(false);
            load();
          }}
        />
      )}
      {openId && (
        <OrderDetail orderId={openId} user={user} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </div>
    </OrderColumnsContext.Provider>
    </OrderSelectionContext.Provider>
  );
}

function SwitchButton({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3.5 py-2 rounded-card text-subhead font-semibold border transition-colors ${
        active ? "bg-accent text-white border-accent" : "border-hairline text-secondary hover:text-primary"
      }`}
    >
      {label}
      <span
        className={`tabular-nums text-caption px-1.5 py-0.5 rounded-full ${
          active ? "bg-white/20" : "bg-black/5 dark:bg-white/10"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// The Trash (§Orders: "ability to delete orders… it should be in the trash
// can in the orders"). A deleted order keeps its invoice number and its
// history and counts nowhere; from here it can come back to the stage it
// left, or be emptied out for good by a manager.
function TrashSection({
  user,
  refreshKey,
  onChanged,
}: {
  user: AppUser;
  refreshKey: number;
  onChanged: () => void;
}) {
  const isManager = user.role === "manager" || user.role === "admin";
  const [rows, setRows] = useState<TrashedOrderRow[]>([]);
  // A manager who rejects the wrong order finds it here beside the deleted
  // ones. The salesman's own Rejected section above is unchanged.
  const [rejected, setRejected] = useState<OrderRow[]>([]);
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    // A salesman sees what they deleted; a manager sees everything.
    const [trashed, turnedDown] = await Promise.all([
      fetchTrashedOrders(supabase, isManager ? {} : { salesmanId: user.id }),
      isManager ? fetchOrders(supabase, { status: ["rejected"] }).catch(() => []) : Promise.resolve([]),
    ]);
    setRows(trashed);
    setRejected(turnedDown);
  }, [isManager, user.id]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // The warehouse never deletes anything, so it never needs the bin.
  if (user.role === "warehouse") return null;

  async function act(id: string, fn: () => Promise<{ stockTaken?: number; status?: string }>, done: string) {
    setBusyId(id);
    try {
      const result = await fn();
      toast.success(
        result.stockTaken
          ? t("orders.doneStockTakenBack", { done, n: result.stockTaken })
          : done
      );
      await load();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, t("orders.thatDidntWork")));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="mb-8 mt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-caption font-semibold text-secondary uppercase tracking-wide mb-2"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Trash2 size={13} />
        {t("orders.trash")} <span className="tabular-nums">({rows.length + rejected.length})</span>
      </button>

      {open && (
        rows.length + rejected.length === 0 ? (
          <div className="text-subhead text-secondary px-1 py-2">{t("orders.nothingDeleted")}</div>
        ) : (
          <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
            {rows.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-subhead font-medium truncate">
                    {o.customer?.name ?? o.new_customer_note ?? t("orders.unnamedCustomer")}
                    {o.invoice_number && (
                      <span className="text-secondary"> · #{o.invoice_number}</span>
                    )}
                  </div>
                  <div className="text-caption text-secondary truncate">
                    {formatAed(o.total ?? 0)}
                    {o.deleted_from_status &&
                      ` · ${t("orders.wasStatus", { status: o.deleted_from_status })}`}
                    {o.deleted_at &&
                      ` · ${t("orders.deletedOn", {
                        date: new Date(o.deleted_at).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                        }),
                      })}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isManager && (
                    <>
                      <Button
                        tier="tinted"
                        disabled={busyId === o.id}
                        className="!px-3 !py-1.5 text-caption"
                        onClick={() => act(o.id, () => restoreOrder(o.id), t("orders.putBack"))}
                      >
                        {t("orders.restore")}
                      </Button>
                      <Button
                        tier="plain"
                        disabled={busyId === o.id}
                        className="!px-3 !py-1.5 text-caption text-[--status-danger]"
                        onClick={() => {
                          const label = o.invoice_number
                            ? t("orders.invoiceLabel", { invoiceNumber: o.invoice_number })
                            : t("orders.thisOrder");
                          if (!confirm(t("orders.purgeConfirm", { label }))) {
                            return;
                          }
                          act(o.id, () => purgeOrder(o.id), t("orders.deletedForGood"));
                        }}
                      >
                        {t("orders.deleteForGood")}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {rejected.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-subhead font-medium truncate">
                    {o.customer?.name ?? o.new_customer_note ?? t("orders.unnamedCustomer")}
                    {o.invoice_number && (
                      <span className="text-secondary"> · #{o.invoice_number}</span>
                    )}
                  </div>
                  <div className="text-caption text-secondary truncate tabular-nums">
                    {formatAed(o.total ?? 0)}
                    {o.rejected_at &&
                      ` · ${t("orders.rejectedOn", {
                        date: new Date(o.rejected_at).toLocaleDateString("en-GB", {
                          day: "2-digit",
                          month: "short",
                        }),
                      })}`}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    tier="tinted"
                    disabled={busyId === o.id}
                    className="!px-3 !py-1.5 text-caption"
                    onClick={() =>
                      act(
                        o.id,
                        async () => {
                          await resubmitOrder(supabaseBrowser(), o.id, user.id);
                          return {};
                        },
                        t("orders.backInPending")
                      )
                    }
                  >
                    {t("orders.restore")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  onOpen,
}: {
  title: string;
  rows: OrderRow[];
  onOpen: (id: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-5">
      <h2 className="text-caption font-semibold text-secondary uppercase tracking-wide mb-2">
        {title} <span className="tabular-nums">({rows.length})</span>
      </h2>
      <OrderList rows={rows} onOpen={onOpen} />
    </div>
  );
}

// Real cursor pagination (§0.4/§0.7) for the unbounded historical buckets —
// Manager's Approved list and Salesman's Past-Orders archive — instead of
// pulling them into the same bounded fetch as the live WIP pipeline.
function PaginatedOrderSection({
  title,
  statusOnly,
  salesmanId,
  onOpen,
  refreshKey,
  search,
  sort,
  billedWindow,
  empty,
}: {
  title?: string;
  statusOnly: OrderStatus[];
  salesmanId?: string;
  onOpen: (id: string) => void;
  refreshKey: number;
  search?: string;
  sort?: OrderSort;
  // Billing-date window (the "This month" view). Taken by time so a new
  // Date in the parent's render does not restart the fetch.
  billedWindow?: { from: Date; to: Date };
  // Shown instead of nothing once the list has loaded empty.
  empty?: ReactNode;
}) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [cursor, setCursor] = useState<OrderCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // Searched in the database, so an order older than the first page is
  // found too. Only the newest request may fill the list: an answer to
  // "45" arriving after the one to "4503" must not replace it.
  const latest = useRef(0);
  const fromMs = billedWindow?.from.getTime();
  const toMs = billedWindow?.to.getTime();
  const reset = useCallback(async () => {
    const ask = ++latest.current;
    const supabase = supabaseBrowser();
    const page = await fetchOrdersPage(supabase, {
      status: statusOnly,
      salesmanId,
      pageSize: 25,
      search,
      from: fromMs === undefined ? undefined : new Date(fromMs),
      to: toMs === undefined ? undefined : new Date(toMs),
    });
    if (ask !== latest.current) return;
    setRows(page.rows);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setLoaded(true);
  }, [statusOnly.join(","), salesmanId, search, fromMs, toMs]);

  // Parent owns the single "orders" Realtime subscription (two
  // useRealtimeTable("orders") calls with no filter collide on the same
  // channel name) — refreshKey is how it tells this section to reload.
  useEffect(() => {
    reset();
  }, [reset, refreshKey]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    const supabase = supabaseBrowser();
    const ask = latest.current;
    const page = await fetchOrdersPage(supabase, {
      status: statusOnly,
      salesmanId,
      cursor,
      pageSize: 25,
      search,
      from: fromMs === undefined ? undefined : new Date(fromMs),
      to: toMs === undefined ? undefined : new Date(toMs),
    });
    if (ask !== latest.current) { setLoadingMore(false); return; }
    setRows((prev) => [...prev, ...page.rows]);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setLoadingMore(false);
  }

  // This archive is paged from the server newest-first (already searched
  // there), so the chosen order applies to what has been loaded. Pressing
  // "Load more" brings in older rows and re-sorts them in with the rest.
  const visibleRows = sortOrders(rows, sort ?? "newest");

  if (!loaded) return null;
  if (rows.length === 0) return <>{empty ?? null}</>;
  return (
    <div className="mb-5">
      {title && (
        <h2 className="text-caption font-semibold text-secondary uppercase tracking-wide mb-2">{title}</h2>
      )}
      <OrderList rows={visibleRows} onOpen={onOpen} />
      {hasMore && (
        <div className="flex justify-center mt-3">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-3.5 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-accent"
          >
            {loadingMore ? t("common.loading") : t("orders.loadMore")}
          </button>
        </div>
      )}
    </div>
  );
}

// Multi-select reaches every list on the page through context rather than
// through Section / PaginatedOrderSection / OrderList one prop at a time.
// Null means "not selecting": rows open as they always have.
interface OrderSelection {
  ids: Set<string>;
  toggle: (id: string) => void;
}
const OrderSelectionContext = createContext<OrderSelection | null>(null);

function OrderList({
  rows,
  onOpen,
}: {
  rows: OrderRow[];
  onOpen: (id: string) => void;
}) {
  const selection = useContext(OrderSelectionContext);
  const columns = useContext(OrderColumnsContext);
  const activate = (id: string) => (selection ? selection.toggle(id) : onOpen(id));
  // "N items" per row (§iPhone orders mockup). Fetched here rather than
  // widening fetchOrders, so the count follows whatever rows are on screen
  // and costs one extra query per page of results.
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({});
  const rowIds = rows.map((o) => o.id).join(",");
  useEffect(() => {
    if (!rowIds) return;
    let cancelled = false;
    orderItemCounts(supabaseBrowser(), rowIds.split(","))
      .then((c) => !cancelled && setItemCounts(c))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rowIds]);

  // Recieved / Balance per order (§desktop Orders mockup).
  const [paidByOrder, setPaidByOrder] = useState<Map<string, number>>(new Map());
  useEffect(() => {
    if (!rowIds) return;
    let cancelled = false;
    fetchPaidByOrder(supabaseBrowser(), rowIds.split(","))
      .then((m) => !cancelled && setPaidByOrder(m))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [rowIds]);

  // GP per order, only while the GP column is on. Keyed on each row's sale
  // as well as its id, so an order whose lines change is worked out again.
  const showGpPct = columns.includes("gpPct");
  const showGp = columns.includes("gp") || showGpPct;
  const gpKey = showGp ? rows.map((o) => `${o.id}:${o.subtotal ?? ""}:${o.total ?? ""}`).join(",") : "";
  const [gpByOrder, setGpByOrder] = useState<Map<string, GrossProfit> | null>(null);
  useEffect(() => {
    if (!gpKey) return;
    let cancelled = false;
    const asked = gpKey.split(",").map((k) => {
      const [id, subtotal, total] = k.split(":");
      return { id, subtotal: subtotal === "" ? null : Number(subtotal), total: total === "" ? null : Number(total) };
    });
    grossProfitByOrder(supabaseBrowser(), asked)
      .then((m) => !cancelled && setGpByOrder(m))
      .catch(() => !cancelled && setGpByOrder(new Map()));
    return () => {
      cancelled = true;
    };
  }, [gpKey]);

  // Date | Invoice | Customer are fixed, then whichever money columns the
  // Adjust View has on, in this order, then Status.
  const moneyColumns = (["amount", "received", "balance", "gp", "gpPct"] as const).filter((c) => columns.includes(c));
  const gridTemplateColumns = `92px 78px minmax(0,1fr) ${moneyColumns.map(() => "110px ").join("")}190px`;

  if (rows.length === 0) {
    return <EmptyState icon={FileText} title={t("orders.nothingHere")} />;
  }
  return (
    <div className="bg-surface border border-hairline rounded-card overflow-hidden">
      {/* §desktop Orders mockup: Date | Invoice | Customer Name | Amount |
          Recieved | Balance | Status, with per-row Excel/PDF; the money
          columns follow the Adjust View. Phones keep the stacked row — this
          table can't fit there. */}
      <div
        className="hidden lg:grid gap-3 px-4 py-2 text-caption text-secondary uppercase font-medium border-b border-hairline"
        style={{ gridTemplateColumns }}
      >
        <span>{t("orders.date")}</span>
        <span>{t("orders.invoice")}</span>
        <span>{t("orders.customerName")}</span>
        {moneyColumns.map((c) => (
          <span key={c} className="text-end">{ORDER_COLUMN_LABELS[c]}</span>
        ))}
        <span className="text-right">{t("orders.status")}</span>
      </div>
      <StaggerList className="divide-y divide-hairline">
        {rows.map((o) => {
          const total = o.total ?? 0;
          const received = paidByOrder.get(o.id) ?? 0;
          const gp = gpByOrder?.get(o.id);
          const gpPct = gp ? gpPercent(gp) : null;
          const gpPartial = gp != null && gp.costedSale > 0 && gp.uncostedSale > 0;
          return (
            <div
              key={o.id}
              onClick={() => activate(o.id)}
              role={selection ? "checkbox" : "button"}
              aria-checked={selection ? selection.ids.has(o.id) : undefined}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  activate(o.id);
                }
              }}
              className={`w-full cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] text-left ${
                selection ? "flex items-center" : ""
              } ${selection?.ids.has(o.id) ? "bg-accent/[0.06]" : ""}`}
            >
              {selection && (
                <span className="ps-4 shrink-0 grid place-items-center min-h-[44px]" aria-hidden>
                  <input
                    type="checkbox"
                    tabIndex={-1}
                    readOnly
                    checked={selection.ids.has(o.id)}
                    className="w-4 h-4 accent-accent pointer-events-none"
                  />
                </span>
              )}
              <div className={selection ? "flex-1 min-w-0" : "contents"}>
              {/* Phone / tablet */}
              <div className="lg:hidden flex items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-subhead font-semibold truncate">
                    {o.customer?.name ?? o.new_customer_note ?? t("orders.unnamedCustomer")}
                  </div>
                  <div className="text-caption text-secondary">
                    {o.invoice_number ? `#${o.invoice_number} · ` : ""}
                    {new Date(o.billed_at ?? o.updated_at).toLocaleDateString()}
                    {o.salesman?.full_name ? ` · ${o.salesman.full_name}` : ""}
                    {columns.includes("district") && o.customer?.district ? ` · ${o.customer.district}` : ""}
                    {itemCounts[o.id] != null
                      ? ` · ${
                          itemCounts[o.id] === 1
                            ? t("orders.itemCountOne", { n: itemCounts[o.id] })
                            : t("orders.itemCountMany", { n: itemCounts[o.id] })
                        }`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {(columns.includes("amount") || showGp) && (
                    <span className="text-end tabular-nums">
                      {columns.includes("amount") && o.total != null && (
                        <span className="block text-caption font-semibold text-secondary">{formatAed(total)}</span>
                      )}
                      {showGp &&
                        (gpByOrder == null ? (
                          <Skeleton className="h-3 w-16 mt-0.5" />
                        ) : (
                          <span
                            className={`block text-caption ${gp && gp.gp < 0 ? "text-[--status-danger]" : "text-secondary"}`}
                            title={gpPartial ? t("orders.gpPartial") : gpPct == null ? t("orders.gpNoCost") : undefined}
                          >
                            {t("orders.gp")}{" "}
                            {gpPct == null
                              ? t("common.notSet")
                              : `${formatAed(gp!.gp)}${showGpPct ? ` · ${gpPct.toFixed(1)}%` : ""}${gpPartial ? " *" : ""}`}
                          </span>
                        ))}
                    </span>
                  )}
                  {/* Changed after it was sent — the same pill an edited
                      payment carries. Absent until RUN-ME-19 has been run. */}
                  {o.edited_at && <Pill tone="warning">{t("orders.edited")}</Pill>}
                  <OrderStatusPill status={o.status} />
                </div>
              </div>

              {/* Desktop table row */}
              <div className="hidden lg:grid gap-3 items-center px-4 py-2.5" style={{ gridTemplateColumns }}>
                <span className="text-caption text-secondary uppercase tabular-nums">
                  {new Date(o.billed_at ?? o.updated_at).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                <span className="text-subhead font-bold tabular-nums">{o.invoice_number ?? t("common.notSet")}</span>
                <span className="min-w-0">
                  <span className="block text-subhead font-semibold truncate">
                    {o.customer?.name ?? o.new_customer_note ?? t("orders.unnamedCustomer")}
                  </span>
                  <span className="block text-caption text-secondary truncate">
                    {[
                      o.salesman?.full_name,
                      columns.includes("district") ? o.customer?.district : null,
                      itemCounts[o.id] != null
                        ? itemCounts[o.id] === 1
                          ? t("orders.itemCountOne", { n: itemCounts[o.id] })
                          : t("orders.itemCountMany", { n: itemCounts[o.id] })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                {columns.includes("amount") && (
                  <span className="text-right text-subhead tabular-nums font-semibold">
                    {formatAed(total)}
                  </span>
                )}
                {columns.includes("received") && (
                  <span className="text-right text-subhead tabular-nums text-accent">
                    {formatAed(received)}
                  </span>
                )}
                {columns.includes("balance") && (
                  <span className="text-right text-subhead tabular-nums font-semibold">
                    {formatAed(Math.max(0, total - received))}
                  </span>
                )}
                {/* GP, with GP % of the costed sale under it. "—" when no
                    line of the order has a cost (every imported invoice);
                    a "*" when some lines have none and were left out. */}
                {columns.includes("gp") && (
                  <span
                    className="text-end tabular-nums"
                    title={gpPartial ? t("orders.gpPartial") : gp && gpPct == null ? t("orders.gpNoCost") : undefined}
                  >
                    {gpByOrder == null ? (
                      <Skeleton className="h-4 w-20 ms-auto" />
                    ) : gpPct == null ? (
                      <span className="text-subhead text-secondary">{t("common.notSet")}</span>
                    ) : (
                      <>
                        <span className={`block text-subhead font-semibold ${gp!.gp < 0 ? "text-[--status-danger]" : ""}`}>
                          {formatAed(gp!.gp)}
                        </span>
                        {!showGpPct && (
                          <span className="block text-caption text-secondary">
                            {gpPct.toFixed(1)}%{gpPartial ? " *" : ""}
                          </span>
                        )}
                      </>
                    )}
                  </span>
                )}
                {/* GP % as its own column (the This month view). */}
                {showGpPct && (
                  <span
                    className="text-end tabular-nums"
                    title={gpPartial ? t("orders.gpPartial") : gp && gpPct == null ? t("orders.gpNoCost") : undefined}
                  >
                    {gpByOrder == null ? (
                      <Skeleton className="h-4 w-14 ms-auto" />
                    ) : gpPct == null ? (
                      <span className="text-subhead text-secondary">{t("common.notSet")}</span>
                    ) : (
                      <span className={`text-subhead font-semibold ${gp!.gp < 0 ? "text-[--status-danger]" : ""}`}>
                        {gpPct.toFixed(1)}%{gpPartial ? " *" : ""}
                      </span>
                    )}
                  </span>
                )}
                <span className="flex items-center justify-end gap-1.5">
                  {o.edited_at && <Pill tone="warning">{t("orders.edited")}</Pill>}
                  <OrderStatusPill status={o.status} />
                  {o.invoice_number && (
                    <>
                      <a
                        href={`/api/orders/excel?orderId=${o.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="px-2 py-1 rounded-card border border-hairline text-[10px] font-semibold text-secondary hover:text-accent hover:border-accent/50"
                        title={t("orders.downloadExcel")}
                      >
                        {t("orders.excel")}
                      </a>
                      <a
                        href={`/api/invoice-pdf?orderId=${o.id}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="px-2 py-1 rounded-card border border-hairline text-[10px] font-semibold text-secondary hover:text-accent hover:border-accent/50"
                        title={t("orders.downloadPdf")}
                      >
                        {t("orders.pdf")}
                      </a>
                    </>
                  )}
                </span>
              </div>
              </div>
            </div>
          );
        })}
      </StaggerList>
    </div>
  );
}
