"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, FileText, ChevronDown, ChevronRight, Search, SlidersHorizontal, PackageCheck, Trash2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchOrders,
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
import { friendlyError } from "@/lib/errors";
import { countOrdersThisMonth, orderItemCounts } from "@/lib/queries/dashboard";
import { fetchPaidByOrder } from "@/lib/queries/aging";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import type { AppUser, OrderStatus } from "@/lib/types/db";
import Button from "@/components/ui/Button";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import { Card } from "@/components/ui/Card";
import { RingProgress } from "@/components/ui/charts";
import ScrollAwayTabs from "@/components/ui/ScrollAwayTabs";
import { fetchDeliveryEnabled } from "@/lib/deliveryStep";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { StaggerList } from "@/components/ui/StaggerList";
import { OrderStatusPill } from "@/components/ui/Badge";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { formatAed } from "@/lib/money";
import NewOrderSheet from "./NewOrderSheet";
import OrderDetail from "./OrderDetail";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { ORDER_ALIASES } from "@/lib/importAliases";

// Orders Adjust View (§Next Updates: "Adjust View option in the all orders
// subtab") — optional extra columns shown per row, same split as the
// Products/Customers Adjust View (fixed identity+status columns, a handful
// of individually-toggleable extras).
type OrderColumnKey = "amount" | "district";
const ALL_ORDER_COLUMNS: OrderColumnKey[] = ["amount", "district"];
const ORDER_COLUMN_LABELS: Record<OrderColumnKey, string> = {
  amount: "Amount",
  district: "District",
};

function OrdersAdjustViewPopover({
  activeColumns,
  onToggleColumn,
}: {
  activeColumns: OrderColumnKey[];
  onToggleColumn: (col: OrderColumnKey) => void;
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
          <div className="absolute right-0 mt-2 w-56 glass rounded-card shadow-floating z-20 p-3">
            <div className="text-caption text-secondary font-semibold mb-1.5">Columns</div>
            {ALL_ORDER_COLUMNS.map((col) => (
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
  { key: "newest", label: "Newest first" },
  { key: "oldest", label: "Oldest first" },
  { key: "invoice_desc", label: "Invoice # (high to low)" },
  { key: "invoice_asc", label: "Invoice # (low to high)" },
  { key: "total_desc", label: "Amount (high to low)" },
  { key: "total_asc", label: "Amount (low to high)" },
  { key: "salesman", label: "Salesman (A–Z)" },
] as const;
type OrderSort = (typeof ORDER_SORTS)[number]["key"];

// Invoice numbers are text in the database, so "9" must not sort above "10".
function invoiceValue(o: OrderRow): number {
  const digits = (o.invoice_number ?? "").replace(/^INV-?/i, "").match(/\d+/);
  return digits ? Number(digits[0]) : -1;
}

function sortOrders(rows: OrderRow[], sort: OrderSort): OrderRow[] {
  const out = [...rows];
  switch (sort) {
    case "oldest":
      return out.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
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
      return out.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }
}

const PIPELINE: OrderStatus[] = [
  "accepted",
  "waiting",
  "picking",
  "packed",
  "approved",
  "edit_requested",
  "delivering",
];

// §Orders summary mockup: Warehouse is a single block whose four stages sit
// inline as pills inside it (Waiting / Picking / Packed / Delivering) —
// picking a stage IS the navigation, so there's no separate "Delivery"
// top-level button and no second sub-nav row underneath.
const WAREHOUSE_STAGES = ["waiting", "picking", "packed", "delivering"] as const;
type WarehouseStage = (typeof WAREHOUSE_STAGES)[number];
const WAREHOUSE_STAGE_LABEL: Record<WarehouseStage, string> = {
  waiting: "Waiting",
  picking: "Picking",
  packed: "Packed",
  // Everything the manager has approved sits here until it is confirmed
  // delivered, so this is the warehouse's round for the day rather than only
  // the orders already out.
  delivering: "Delivery",
};

export default function OrdersView({
  user,
  scope = "all",
}: {
  user: AppUser;
  scope?: "all" | "picking";
}) {
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
  const [sort, setSort] = useState<OrderSort>("newest");
  const { preferences, update: updatePrefs } = usePreferences();
  const activeOrderColumns = (preferences.ordersColumns as OrderColumnKey[] | undefined) ?? [];
  // Manager's Orders/New Orders/Warehouse switcher (§1.3) — the other roles
  // keep their existing bucketed views untouched.
  const [managerView, setManagerView] = useState<"new" | "warehouse" | "all">("new");
  const [warehouseStage, setWarehouseStage] = useState<WarehouseStage>("waiting");
  // Bumped whenever a "orders" Realtime event fires — PaginatedOrderSection
  // watches this instead of subscribing itself: two useRealtimeTable("orders")
  // calls with no filter would collide on the same channel name.
  const [refreshKey, setRefreshKey] = useState(0);

  // WIP pipeline is naturally small/bounded (this is the fetch), unlike the
  // Delivered / Past-Orders archives which grow forever — those go through
  // <PaginatedOrderSection> (real cursor pagination, §0.4/§0.7) below
  // instead of being pulled into this array.
  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const salesmanId = user.role === "salesman" ? user.id : undefined;
    const [rows, count, mCount] = await Promise.all([
      fetchOrders(supabase, { salesmanId, excludeStatus: ["delivered"], limit: 300 }),
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

  useRealtimeTable("orders", () => {
    load();
    setRefreshKey((k) => k + 1);
  });

  interface Sections {
    drafts?: OrderRow[];
    pending?: OrderRow[];
    past?: OrderRow[]; // WIP-only ("past" minus delivered — delivered is paginated separately below)
    rejected?: OrderRow[];
    queue?: OrderRow[];
    pipeline?: OrderRow[];
    other?: OrderRow[];
  }

  const isManager = (user.role === "manager" || user.role === "admin");

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
      const relevant = scope === "picking"
        ? searchedOrders.filter((o) => ["waiting", "picking"].includes(o.status))
        : searchedOrders.filter((o) => PIPELINE.includes(o.status) || o.status === "delivering");
      return { queue: relevant };
    }
    // manager, "all" sub-tab
    const filtered = statusFilter ? searchedOrders.filter((o) => o.status === statusFilter) : searchedOrders;
    return {
      pending: filtered.filter((o) => o.status === "pending"),
      pipeline: filtered.filter((o) => PIPELINE.includes(o.status)),
      rejected: filtered.filter((o) => o.status === "rejected"),
      other: filtered.filter(
        (o) =>
          !["pending", "rejected", "delivered", "draft"].includes(o.status) &&
          !PIPELINE.includes(o.status)
      ),
    };
  }, [searchedOrders, user.role, scope, statusFilter]);

  const switcherStats = useMemo(() => {
    if (!isManager || scope === "picking") return null;
    const count = (s: OrderStatus) => orders.filter((o) => o.status === s).length;
    // "accepted" is the pre-picking state the warehouse still sees as
    // Waiting, so it's folded into that stage's count (and its rows below).
    const stageCounts = {
      waiting: orders.filter((o) => ["waiting", "accepted"].includes(o.status)).length,
      picking: count("picking"),
      packed: count("packed"),
      delivering: count("delivering"),
    } satisfies Record<WarehouseStage, number>;
    return {
      newOrders: count("pending"),
      stageCounts,
      warehouseCount: Object.values(stageCounts).reduce((a, b) => a + b, 0),
      all: totalCount,
      thisMonth: monthCount,
    };
  }, [orders, isManager, scope, totalCount, monthCount]);

  // The manager has always been able to step through the warehouse stages.
  // The warehouse itself could not: it saw one flat queue mixing orders not yet
  // started with ones half-picked and ones already packed, which is the wrong
  // shape for the person actually doing the work.
  const isWarehouse = user.role === "warehouse";
  const showsWarehouseStages = isWarehouse && scope !== "picking";

  // Whether this business tracks deliveries at all. Starts true so the tab is
  // not missing on first paint for the businesses that do use it.
  const [deliveryEnabled, setDeliveryEnabled] = useState(true);
  useEffect(() => {
    fetchDeliveryEnabled(supabaseBrowser()).then(setDeliveryEnabled).catch(() => {});
  }, []);
  const stages = useMemo(
    () => (deliveryEnabled ? WAREHOUSE_STAGES : WAREHOUSE_STAGES.filter((st) => st !== "delivering")),
    [deliveryEnabled]
  );

  // If delivery is switched off while that tab is open, fall back rather than
  // showing an empty tab that no longer has a button.
  useEffect(() => {
    if (!deliveryEnabled && warehouseStage === "delivering") setWarehouseStage("packed");
  }, [deliveryEnabled, warehouseStage]);
  const warehouseRows = useMemo(() => {
    if (!isManager && !showsWarehouseStages) return [];
    // "Accepted" is an order that has reached the warehouse but nobody has
    // picked yet, so it belongs under Waiting rather than in a stage of its own.
    if (warehouseStage === "waiting") return searchedOrders.filter((o) => ["waiting", "accepted"].includes(o.status));
    // An approved order has not left yet but is the warehouse's to take out,
    // so Delivery holds both it and anything already on the road.
    if (warehouseStage === "delivering") {
      return searchedOrders.filter((o) => ["approved", "delivering"].includes(o.status));
    }
    return searchedOrders.filter((o) => o.status === warehouseStage);
  }, [searchedOrders, isManager, showsWarehouseStages, warehouseStage]);

  // Counts sit on the tabs so the warehouse can see where the work is without
  // opening each one.
  const warehouseStageCounts = useMemo(() => {
    const count = (stage: WarehouseStage) => {
      if (stage === "waiting") {
        return searchedOrders.filter((o) => ["waiting", "accepted"].includes(o.status)).length;
      }
      if (stage === "delivering") {
        return searchedOrders.filter((o) => ["approved", "delivering"].includes(o.status)).length;
      }
      return searchedOrders.filter((o) => o.status === stage).length;
    };
    return Object.fromEntries(WAREHOUSE_STAGES.map((st) => [st, count(st)])) as Record<WarehouseStage, number>;
  }, [searchedOrders]);

  if (loading) return <SkeletonList rows={6} />;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">
          {scope === "picking" ? "Picking" : "Orders"}
        </h1>
        <div className="flex items-center gap-4 flex-wrap">
          {/* A day's orders taken on paper or in a supplier's sheet, brought
              in as whole orders for review rather than typed again. */}
          {isManager && (
            <ImportCsvButton
              endpoint="/api/orders/import"
              onImported={load}
              label="Import orders"
              unit="order"
              aliases={ORDER_ALIASES}
              sample={{
                filename: "orders_sample.csv",
                headers: [
                  { key: "Invoice" },
                  { key: "Customer", required: true },
                  { key: "Article", required: true },
                  { key: "Quantity", required: true },
                  { key: "Price" },
                  { key: "Salesman" },
                ],
                example: {
                  Invoice: "A-1",
                  Customer: "20001",
                  Article: "TTS100",
                  Quantity: 12,
                  Price: "",
                  Salesman: "",
                },
              }}
            />
          )}
          {user.role !== "warehouse" && (
            <Button tier="primary" onClick={() => setShowNew(true)} className="flex items-center gap-1.5">
              <Plus size={16} /> New order
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer or invoice #"
            className="w-full pl-9 pr-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
          />
        </div>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as OrderSort)}
          aria-label="Sort orders"
          className="px-3 py-2.5 rounded-card border border-hairline bg-surface text-subhead"
        >
          {ORDER_SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {switcherStats && (
        <ScrollAwayTabs>
          <Card className="p-4 mb-5">
            <div className="flex items-start gap-5 flex-wrap">
              <div className="flex flex-col items-center gap-1.5 shrink-0">
                <RingProgress
                  value={switcherStats.newOrders}
                  max={Math.max(1, switcherStats.all)}
                  label={String(switcherStats.newOrders)}
                />
                <span className="text-caption font-semibold text-secondary">Pending</span>
              </div>

              <div className="flex-1 min-w-[220px] flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <SwitchButton
                    label="New Orders"
                    count={switcherStats.newOrders}
                    active={managerView === "new"}
                    onClick={() => setManagerView("new")}
                  />
                  <SwitchButton
                    label="All Orders"
                    count={switcherStats.all}
                    active={managerView === "all"}
                    onClick={() => setManagerView("all")}
                  />
                  <span className="text-caption text-secondary ml-auto tabular-nums">
                    {switcherStats.thisMonth} this month
                  </span>
                </div>

                <div
                  className={`rounded-card border p-3 transition-colors ${
                    managerView === "warehouse" ? "border-accent/40 bg-accent/[0.04]" : "border-hairline"
                  }`}
                >
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-subhead font-semibold">Warehouse</span>
                    <span className="text-caption text-secondary tabular-nums">{switcherStats.warehouseCount}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {stages.map((stage) => {
                      const isActive = managerView === "warehouse" && warehouseStage === stage;
                      return (
                        <button
                          key={stage}
                          onClick={() => {
                            setManagerView("warehouse");
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
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </ScrollAwayTabs>
      )}

      {isManager && managerView === "new" && (
        <Section title="New orders to review" rows={sections.pending ?? []} onOpen={setOpenId} />
      )}
      {isManager && managerView === "warehouse" && (
        <Section title={WAREHOUSE_STAGE_LABEL[warehouseStage]} rows={warehouseRows} onOpen={setOpenId} />
      )}

      {showsWarehouseStages && (
        <>
          <div className="flex items-center gap-2 flex-wrap mb-4">
            {stages.map((stage) => {
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
              title={`Nothing ${WAREHOUSE_STAGE_LABEL[warehouseStage].toLowerCase()} right now.`}
            />
          )}
        </>
      )}

      {(!isManager || managerView === "all") && !showsWarehouseStages && (
        <>
          {isManager && (
            <div className="mb-4 flex items-center gap-2">
              <select
                className="px-3 py-2 rounded-card border border-hairline bg-surface text-subhead"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="">All statuses</option>
                {["pending", "waiting", "picking", "packed", "approved", "edit_requested", "delivering", "delivered", "rejected", "cancelled"].map(
                  (s) => (
                    <option key={s} value={s}>{s}</option>
                  )
                )}
              </select>
              <OrdersAdjustViewPopover
                activeColumns={activeOrderColumns}
                onToggleColumn={(col) => {
                  const next = activeOrderColumns.includes(col)
                    ? activeOrderColumns.filter((c) => c !== col)
                    : [...activeOrderColumns, col];
                  updatePrefs({ ordersColumns: next });
                }}
              />
            </div>
          )}

          {sections.drafts && sections.drafts.length > 0 && (
            <div className="mb-4">
              <button
                className="flex items-center gap-1.5 text-subhead font-semibold mb-2"
                onClick={() => setDraftsOpen((v) => !v)}
              >
                {draftsOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                Drafts
                <span className="px-2 py-0.5 rounded-full bg-warning/20 text-[--status-warning] text-caption font-bold">
                  {sections.drafts.length}
                </span>
              </button>
              {draftsOpen && <OrderList rows={sections.drafts} onOpen={setOpenId} />}
            </div>
          )}

          {sections.pending && !isManager && (
            <Section title="Pending" rows={sections.pending} onOpen={setOpenId} />
          )}
          {isManager && sections.pending && (
            <Section title="New orders to review" rows={sections.pending} onOpen={setOpenId} columns={activeOrderColumns} />
          )}
          {sections.pipeline && <Section title="In progress" rows={sections.pipeline} onOpen={setOpenId} columns={isManager ? activeOrderColumns : undefined} />}
          {sections.queue && <Section title={scope === "picking" ? "To pick" : "Queue"} rows={sections.queue} onOpen={setOpenId} />}
          {sections.past && sections.past.length > 0 && <Section title="Past" rows={sections.past} onOpen={setOpenId} />}
          {user.role === "salesman" && (
            <PaginatedOrderSection
              title={sections.past && sections.past.length > 0 ? undefined : "Past"}
              statusOnly={["delivered"]}
              salesmanId={user.id}
              onOpen={setOpenId}
              refreshKey={refreshKey}
              search={search}
              sort={sort}
            />
          )}
          {isManager && (!statusFilter || statusFilter === "delivered") && (
            <PaginatedOrderSection
              title="Delivered"
              statusOnly={["delivered"]}
              onOpen={setOpenId}
              refreshKey={refreshKey}
              search={search}
              columns={activeOrderColumns}
              sort={sort}
            />
          )}
          {sections.other && sections.other.length > 0 && <Section title="Other" rows={sections.other} onOpen={setOpenId} columns={isManager ? activeOrderColumns : undefined} />}
          {sections.rejected && <Section title="Rejected" rows={sections.rejected} onOpen={setOpenId} columns={isManager ? activeOrderColumns : undefined} />}
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
  const [open, setOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    // A salesman sees what they deleted; a manager sees everything.
    setRows(await fetchTrashedOrders(supabase, isManager ? {} : { salesmanId: user.id }));
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
        result.stockTaken ? `${done} ${result.stockTaken} taken back out of stock.` : done
      );
      await load();
      onChanged();
    } catch (e) {
      toast.error(friendlyError(e, "That didn't work."));
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
        Trash <span className="tabular-nums">({rows.length})</span>
      </button>

      {open && (
        rows.length === 0 ? (
          <div className="text-subhead text-secondary px-1 py-2">Nothing deleted.</div>
        ) : (
          <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
            {rows.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <div className="text-subhead font-medium truncate">
                    {o.customer?.name ?? o.new_customer_note ?? "Unnamed customer"}
                    {o.invoice_number && (
                      <span className="text-secondary"> · #{o.invoice_number}</span>
                    )}
                  </div>
                  <div className="text-caption text-secondary truncate">
                    {formatAed(o.total ?? 0)}
                    {o.deleted_from_status && ` · was ${o.deleted_from_status}`}
                    {o.deleted_at &&
                      ` · deleted ${new Date(o.deleted_at).toLocaleDateString("en-GB", {
                        day: "2-digit",
                        month: "short",
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
                        onClick={() => act(o.id, () => restoreOrder(o.id), "Put back.")}
                      >
                        Restore
                      </Button>
                      <Button
                        tier="plain"
                        disabled={busyId === o.id}
                        className="!px-3 !py-1.5 text-caption text-[--status-danger]"
                        onClick={() => {
                          const label = o.invoice_number ? `Invoice ${o.invoice_number}` : "This order";
                          if (
                            !confirm(
                              `${label} and its lines are removed for good. This cannot be undone.`
                            )
                          ) {
                            return;
                          }
                          act(o.id, () => purgeOrder(o.id), "Deleted for good.");
                        }}
                      >
                        Delete for good
                      </Button>
                    </>
                  )}
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
  columns,
}: {
  title: string;
  rows: OrderRow[];
  onOpen: (id: string) => void;
  columns?: OrderColumnKey[];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-5">
      <h2 className="text-caption font-semibold text-secondary uppercase tracking-wide mb-2">
        {title} <span className="tabular-nums">({rows.length})</span>
      </h2>
      <OrderList rows={rows} onOpen={onOpen} columns={columns} />
    </div>
  );
}

// Real cursor pagination (§0.4/§0.7) for the unbounded historical buckets —
// Manager's Delivered list and Salesman's Past-Orders archive — instead of
// pulling them into the same bounded fetch as the live WIP pipeline.
function PaginatedOrderSection({
  title,
  statusOnly,
  salesmanId,
  onOpen,
  refreshKey,
  search,
  columns,
  sort,
}: {
  title?: string;
  statusOnly: OrderStatus[];
  salesmanId?: string;
  onOpen: (id: string) => void;
  refreshKey: number;
  search?: string;
  columns?: OrderColumnKey[];
  sort?: OrderSort;
}) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [cursor, setCursor] = useState<OrderCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const reset = useCallback(async () => {
    const supabase = supabaseBrowser();
    const page = await fetchOrdersPage(supabase, { status: statusOnly, salesmanId, pageSize: 25 });
    setRows(page.rows);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setLoaded(true);
  }, [statusOnly.join(","), salesmanId]);

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
    const page = await fetchOrdersPage(supabase, { status: statusOnly, salesmanId, cursor, pageSize: 25 });
    setRows((prev) => [...prev, ...page.rows]);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setLoadingMore(false);
  }

  const term = (search ?? "").trim().toLowerCase();
  const matchedRows = term
    ? rows.filter((o) => {
        const name = (o.customer?.name ?? o.new_customer_note ?? "").toLowerCase();
        const invoice = (o.invoice_number ?? "").toLowerCase();
        return name.includes(term) || invoice.includes(term);
      })
    : rows;
  // This archive is paged from the server newest-first, so the chosen order
  // applies to what has been loaded. Pressing "Load more" brings in older
  // rows and re-sorts them in with the rest.
  const visibleRows = sortOrders(matchedRows, sort ?? "newest");

  if (!loaded || rows.length === 0) return null;
  return (
    <div className="mb-5">
      {title && (
        <h2 className="text-caption font-semibold text-secondary uppercase tracking-wide mb-2">{title}</h2>
      )}
      <OrderList rows={visibleRows} onOpen={onOpen} columns={columns} />
      {hasMore && (
        <div className="flex justify-center mt-3">
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="px-3.5 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-accent"
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function OrderList({
  rows,
  onOpen,
  columns = [],
}: {
  rows: OrderRow[];
  onOpen: (id: string) => void;
  columns?: OrderColumnKey[];
}) {
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

  if (rows.length === 0) {
    return <EmptyState icon={FileText} title="Nothing here" />;
  }
  return (
    <div className="bg-surface border border-hairline rounded-card overflow-hidden">
      {/* §desktop Orders mockup: Date | Invoice | Customer Name | Amount |
          Recieved | Balance | Status, with per-row Excel/PDF. Phones keep
          the stacked row — this table can't fit there. */}
      <div className="hidden lg:grid grid-cols-[92px_78px_1fr_110px_110px_110px_190px] gap-3 px-4 py-2 text-caption text-secondary uppercase font-medium border-b border-hairline">
        <span>Date</span>
        <span>Invoice</span>
        <span>Customer Name</span>
        <span className="text-right">Amount</span>
        <span className="text-right">Received</span>
        <span className="text-right">Balance</span>
        <span className="text-right">Status</span>
      </div>
      <StaggerList className="divide-y divide-hairline">
        {rows.map((o) => {
          const total = o.total ?? 0;
          const received = paidByOrder.get(o.id) ?? 0;
          return (
            <div
              key={o.id}
              onClick={() => onOpen(o.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onOpen(o.id);
                }
              }}
              className="w-full cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03] text-left"
            >
              {/* Phone / tablet */}
              <div className="lg:hidden flex items-center justify-between gap-3 px-4 py-3.5">
                <div className="min-w-0">
                  <div className="text-subhead font-semibold truncate">
                    {o.customer?.name ?? o.new_customer_note ?? "Unnamed customer"}
                  </div>
                  <div className="text-caption text-secondary">
                    {o.invoice_number ? `#${o.invoice_number} · ` : ""}
                    {new Date(o.created_at).toLocaleDateString()}
                    {o.salesman?.full_name ? ` · ${o.salesman.full_name}` : ""}
                    {columns.includes("district") && o.customer?.district ? ` · ${o.customer.district}` : ""}
                    {itemCounts[o.id] != null
                      ? ` · ${itemCounts[o.id]} ${itemCounts[o.id] === 1 ? "item" : "items"}`
                      : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  {columns.includes("amount") && o.total != null && (
                    <span className="text-caption font-semibold text-secondary tabular-nums">
                      {formatAed(total)}
                    </span>
                  )}
                  <OrderStatusPill status={o.status} />
                </div>
              </div>

              {/* Desktop table row */}
              <div className="hidden lg:grid grid-cols-[92px_78px_1fr_110px_110px_110px_190px] gap-3 items-center px-4 py-2.5">
                <span className="text-caption text-secondary uppercase tabular-nums">
                  {new Date(o.created_at).toLocaleDateString("en-GB", {
                    day: "2-digit",
                    month: "short",
                    year: "numeric",
                  })}
                </span>
                <span className="text-subhead font-bold tabular-nums">{o.invoice_number ?? "—"}</span>
                <span className="min-w-0">
                  <span className="block text-subhead font-semibold truncate">
                    {o.customer?.name ?? o.new_customer_note ?? "Unnamed customer"}
                  </span>
                  <span className="block text-caption text-secondary truncate">
                    {[
                      o.salesman?.full_name,
                      columns.includes("district") ? o.customer?.district : null,
                      itemCounts[o.id] != null
                        ? `${itemCounts[o.id]} ${itemCounts[o.id] === 1 ? "item" : "items"}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="text-right text-subhead tabular-nums font-semibold">
                  {formatAed(total)}
                </span>
                <span className="text-right text-subhead tabular-nums text-accent">
                  {formatAed(received)}
                </span>
                <span className="text-right text-subhead tabular-nums font-semibold">
                  {formatAed(Math.max(0, total - received))}
                </span>
                <span className="flex items-center justify-end gap-1.5">
                  <OrderStatusPill status={o.status} />
                  {o.invoice_number && (
                    <>
                      <a
                        href={`/api/orders/excel?orderId=${o.id}`}
                        onClick={(e) => e.stopPropagation()}
                        className="px-2 py-1 rounded-card border border-hairline text-[10px] font-semibold text-secondary hover:text-accent hover:border-accent/50"
                        title="Download Excel"
                      >
                        Excel
                      </a>
                      <a
                        href={`/api/invoice-pdf?orderId=${o.id}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="px-2 py-1 rounded-card border border-hairline text-[10px] font-semibold text-secondary hover:text-accent hover:border-accent/50"
                        title="Download PDF"
                      >
                        PDF
                      </a>
                    </>
                  )}
                </span>
              </div>
            </div>
          );
        })}
      </StaggerList>
    </div>
  );
}
