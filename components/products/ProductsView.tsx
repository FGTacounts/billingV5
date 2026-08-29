"use client";

import { toast } from "@/lib/toast";
import { Fragment, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { List, Search, Plus, Package, GalleryHorizontal, Pencil, SlidersHorizontal, Folder, ChevronLeft } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchProducts, createProduct, updateProduct, fetchProductInsights, fetchLastSoldPrice, resolveProductFigures, type ProductInsight, type LastSoldPrice } from "@/lib/queries/products";
import type { Product } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import Button from "@/components/ui/Button";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import Sheet from "@/components/ui/Sheet";
import { Label, TextInput } from "@/components/ui/Field";
import BarcodeScanButton from "@/components/ui/BarcodeScanButton";
import ImportCsvButton from "@/components/ui/ImportCsvButton";
import { PRODUCT_ALIASES } from "@/lib/importAliases";
import { usePreferences } from "@/lib/hooks/usePreferences";
import PinnableOptionsButton from "@/components/ui/PinnableOptions";
import { usePagination, Pagination } from "@/components/ui/Pagination";
import SegmentedControl from "@/components/ui/SegmentedControl";

type SortKey = "none" | "sku" | "price_asc" | "price_desc" | "stock_asc" | "lowStock";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "sku", label: "SKU (A–Z)" },
  { key: "price_asc", label: "Price (low to high)" },
  { key: "price_desc", label: "Price (high to low)" },
  { key: "stock_asc", label: "Stock (low to high)" },
  { key: "lowStock", label: "Low stock" },
];

type ViewMode = "list" | "gallery";
const VIEW_MODES: { key: ViewMode; label: string; icon: typeof List }[] = [
  { key: "list", label: "List", icon: List },
  { key: "gallery", label: "Gallery", icon: GalleryHorizontal },
];

// No threshold was specified in any design doc — 10 units is a reasonable
// documented default for "running low" until Manager feedback tunes it.
const LOW_STOCK_THRESHOLD = 10;

// Adjust View (§Products, §Next Updates: "Adjust View must apply to ALL
// view types with an expanded field list") — which optional columns show,
// individually toggleable across List/Icon/Gallery/Column, plus a few named
// default views that set a whole column set at once. SKU/Description/Price
// stay as fixed identity fields — only these are optional. VAC/VAC China/
// SAD/SHD/Sale/Sold/GP come from fetchProductInsights (Manager-only,
// batch-fetched only when one of these is active — see insightColumns).
type ColumnKey =
  | "category"
  | "cost"
  | "stock_on_hand"
  | "rack_location"
  | "barcode"
  | "default_qty"
  | "vac"
  | "vacChina"
  | "sad"
  | "shd"
  | "sale"
  | "sold"
  | "gp";
const ALL_COLUMNS: ColumnKey[] = [
  "category",
  "cost",
  "stock_on_hand",
  "rack_location",
  "barcode",
  "default_qty",
  "vac",
  "vacChina",
  "sad",
  "shd",
  "sale",
  "sold",
  "gp",
];
const INSIGHT_COLUMNS: ColumnKey[] = ["vac", "vacChina", "sad", "shd", "sale", "sold", "gp"];
const COLUMN_LABELS: Record<ColumnKey, string> = {
  category: "Category",
  cost: "Cost",
  stock_on_hand: "Stock on hand",
  rack_location: "Rack",
  barcode: "Barcode",
  default_qty: "Default qty",
  vac: "VAC",
  vacChina: "VAC China",
  sad: "SAD",
  shd: "SHD",
  sale: "Sale",
  sold: "Sold",
  gp: "GP",
};

const INSIGHT_DAY_OPTIONS = [30, 60, 90] as const;

// Sale/Sold column headers carry the active lookback window (§Products:
// "Adjust View columns need date/time range adjustability").
function columnLabel(col: ColumnKey, days: number): string {
  if (col === "sale" || col === "sold") return `${COLUMN_LABELS[col]} (${days}d)`;
  return COLUMN_LABELS[col];
}
const PRODUCT_VIEWS: { key: string; label: string; columns: ColumnKey[] }[] = [
  // §Products mockup draws the default list as SKU / Description / Price /
  // VAC / GP / Sale / Sold / Stock. The insight columns are batch-fetched
  // for the rows on screen only (capped at 150), so this stays affordable
  // on the full catalogue.
  { key: "default", label: "Default", columns: ["vac", "gp", "sale", "sold", "stock_on_hand"] },
  { key: "stockMovement", label: "Stock movement", columns: ["stock_on_hand", "rack_location", "default_qty"] },
  { key: "pricing", label: "Pricing", columns: ["cost"] },
  { key: "salesInsight", label: "Sales insight", columns: ["sale", "sold", "gp", "shd"] },
  { key: "all", label: "All columns", columns: ALL_COLUMNS },
];

interface CustomProductView {
  key: string;
  label: string;
  columns: ColumnKey[];
}

function AdjustViewPopover({
  activeColumns,
  activeViewKey,
  customViews,
  onSelectView,
  onToggleColumn,
  onSaveCustom,
  onDeleteCustom,
  insightDays,
  onChangeInsightDays,
}: {
  activeColumns: ColumnKey[];
  activeViewKey: string | undefined;
  customViews: CustomProductView[];
  onSelectView: (view: { key: string; columns: ColumnKey[] }) => void;
  onToggleColumn: (col: ColumnKey) => void;
  onSaveCustom: (name: string) => void;
  onDeleteCustom: (key: string) => void;
  insightDays: number;
  onChangeInsightDays: (days: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [namingPreset, setNamingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    onSaveCustom(name);
    setPresetName("");
    setNamingPreset(false);
  }

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
          <div className="absolute right-0 mt-2 w-72 glass rounded-card shadow-floating z-20 p-3">
            <div className="text-caption text-secondary font-semibold mb-1.5">Default views</div>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {PRODUCT_VIEWS.map((v) => (
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

            {customViews.length > 0 && (
              <>
                <div className="text-caption text-secondary font-semibold mb-1.5">Your presets</div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {customViews.map((v) => (
                    <span key={v.key} className="inline-flex items-center">
                      <button
                        onClick={() => onSelectView(v)}
                        className={`pl-2.5 pr-1.5 py-1 rounded-l-card text-caption font-medium border ${
                          activeViewKey === v.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                        }`}
                      >
                        {v.label}
                      </button>
                      <button
                        onClick={() => onDeleteCustom(v.key)}
                        aria-label={`Delete ${v.label}`}
                        className={`pr-2 pl-0.5 py-1 rounded-r-card text-caption border border-l-0 ${
                          activeViewKey === v.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                        }`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              </>
            )}

            <div className="text-caption text-secondary font-semibold mb-1.5">Columns</div>
            {ALL_COLUMNS.map((col) => (
              <label key={col} className="flex items-center gap-2 py-1 text-subhead">
                <input
                  type="checkbox"
                  checked={activeColumns.includes(col)}
                  onChange={() => onToggleColumn(col)}
                />
                {columnLabel(col, insightDays)}
              </label>
            ))}

            {(activeColumns.includes("sale") || activeColumns.includes("sold")) && (
              <div className="pt-2 mt-1 border-t border-hairline">
                <div className="text-caption text-secondary font-semibold mb-1.5">Sale/Sold window</div>
                <div className="flex gap-1.5">
                  {INSIGHT_DAY_OPTIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => onChangeInsightDays(d)}
                      className={`flex-1 px-2 py-1 rounded-inner text-caption font-medium border ${
                        insightDays === d ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                      }`}
                    >
                      {d}d
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-2 mt-2 border-t border-hairline">
              {namingPreset ? (
                <div className="flex items-center gap-1.5">
                  <input
                    autoFocus
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && savePreset()}
                    placeholder="Preset name"
                    className="flex-1 min-w-0 px-2 py-1 rounded-inner border border-hairline bg-canvas text-caption"
                  />
                  <Button tier="tinted" onClick={savePreset}>Save</Button>
                </div>
              ) : (
                <Button
                  tier="tinted"
                  onClick={() => setNamingPreset(true)}
                  className="w-full"
                >
                  + Save current as preset
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ProductsView({ isManager }: { isManager: boolean }) {
  const [view, setView] = useState<ViewMode>("list");
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [viewing, setViewing] = useState<Product | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [insights, setInsights] = useState<Map<string, ProductInsight>>(new Map());
  const [insightDays, setInsightDays] = useState(90);
  const [sortKey, setSortKey] = useState<SortKey>("none");
  const { preferences, update: updatePrefs } = usePreferences();
  const pinnedSorts = preferences.pinnedProductSort ?? [];
  const customViews = useMemo(
    () => (preferences.productCustomViews ?? []) as CustomProductView[],
    [preferences.productCustomViews]
  );
  const activeView =
    PRODUCT_VIEWS.find((v) => v.key === preferences.productView) ??
    customViews.find((v) => v.key === preferences.productView) ??
    PRODUCT_VIEWS[0];
  const activeColumns = (preferences.productColumns as ColumnKey[] | undefined) ?? activeView.columns;

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    setProducts(await fetchProducts(supabase, { search: search || undefined }));
    setLoading(false);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);

  const visibleProducts = useMemo(() => {
    let base = products;
    if (sortKey === "lowStock") {
      return base.filter((p) => p.stock_on_hand != null && p.stock_on_hand < LOW_STOCK_THRESHOLD);
    }
    if (sortKey === "sku") return [...base].sort((a, b) => a.sku.localeCompare(b.sku));
    if (sortKey === "price_asc") return [...base].sort((a, b) => a.price - b.price);
    if (sortKey === "price_desc") return [...base].sort((a, b) => b.price - a.price);
    if (sortKey === "stock_asc") {
      return [...base].sort((a, b) => (a.stock_on_hand ?? Infinity) - (b.stock_on_hand ?? Infinity));
    }
    return base;
  }, [products, sortKey, search]);

  // 1,300+ rows rendered at once is what made scrolling stick — and on this
  // page every row also fires a photo request. Fifty at a time by default.
  const pager = usePagination(visibleProducts, 50);
  const pagedProducts = pager.visible;

  // Gallery browses by category folder first (§iPhone mockup). A search
  // skips the folder level — you're looking for a product, not a category.
  const [galleryCategory, setGalleryCategory] = useState<string | null>(null);
  const galleryFolders = useMemo(() => {
    if (search.trim()) return [];
    const counts = new Map<string, number>();
    for (const p of visibleProducts) {
      const name = p.category ?? "Uncategorised";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [visibleProducts, search]);
  const galleryProducts = useMemo(
    () =>
      galleryCategory === null
        ? pagedProducts
        : pagedProducts.filter((p) => (p.category ?? "Uncategorised") === galleryCategory),
    [pagedProducts, galleryCategory]
  );

  // Batch-fetch VAC/SAD/Sale/Sold/GP insights for whatever's currently on
  // screen when one of those columns is toggled on — capped at 150 rows so
  // an unfiltered "all products" list (1000+ SKUs) can't trigger a huge
  // purchases+order_items join; narrow via search/category to see insights
  // on a bigger set.
  useEffect(() => {
    if (!isManager) return;
    const needsInsights = activeColumns.some((c) => INSIGHT_COLUMNS.includes(c));
    if (!needsInsights) return;
    if (pagedProducts.length === 0) return;
    // Only for the rows actually on screen. This used to bail out entirely
    // above 150 products, so the insight columns silently stayed empty on a
    // full catalogue; paging means the request is always small enough to run.
    const missingIds = pagedProducts.filter((p) => !insights.has(p.id)).map((p) => p.id);
    if (missingIds.length === 0) return;
    fetchProductInsights(supabaseBrowser(), missingIds, insightDays).then((map) => {
      setInsights((prev) => new Map([...prev, ...map]));
    });
  }, [isManager, activeColumns, pagedProducts, insights, insightDays]);

  // Cached insight values are specific to the lookback window they were
  // fetched with — switching 30d/60d/90d invalidates the whole cache so the
  // effect above refetches everything currently on screen.
  function changeInsightDays(days: number) {
    setInsightDays(days);
    setInsights(new Map());
  }

  async function toggleExpand(p: Product) {
    if (expandedId === p.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(p.id);
    if (isManager && !insights.has(p.id)) {
      const map = await fetchProductInsights(supabaseBrowser(), [p.id], insightDays);
      setInsights((prev) => new Map([...prev, ...map]));
    }
  }

  // Icon/Gallery/Column tiles open a read-only detail page (§Next Updates:
  // "new product-detail page layout") instead of jumping straight to the
  // edit form — editing is a deliberate action from inside that page now.
  async function openDetail(p: Product) {
    setViewing(p);
    if (isManager && !insights.has(p.id)) {
      const map = await fetchProductInsights(supabaseBrowser(), [p.id], insightDays);
      setInsights((prev) => new Map([...prev, ...map]));
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">Products</h1>
        <div className="flex items-center gap-4 flex-wrap">
          {isManager && (
            <ImportCsvButton
              endpoint="/api/products/import"
              onImported={load}
              askStockMode
              aliases={PRODUCT_ALIASES}
              sample={{
                // Header labels match your Articles & Stock V5.0.xlsx STOCK
                // sheet exactly, so that sheet (or a copy of it) can be
                // uploaded as-is — no reformatting needed.
                filename: "products_sample.csv",
                headers: [
                  { key: "ARTICLE", required: true },
                  { key: "DESCRIPTION", required: true },
                  { key: "PRICE" },
                  { key: "Cost" },
                  { key: "Stock" },
                  { key: "Default Qty" },
                  { key: "Rack" },
                  { key: "BARCODE" },
                  { key: "Category" },
                ],
                example: {
                  ARTICLE: "TTS100",
                  DESCRIPTION: "Example product",
                  PRICE: 25,
                  Cost: 15,
                  Stock: 100,
                  "Default Qty": 12,
                  Rack: "",
                  BARCODE: "",
                  Category: "",
                },
              }}
            />
          )}
        {isManager && <ExportLink type="products" />}
          {isManager && (
            <Button tier="primary" onClick={() => setEditing("new")} className="flex items-center gap-1.5">
              <Plus size={16} /> Add product
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            className="w-full pl-9 pr-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
            placeholder="Search SKU or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <BarcodeScanButton onScan={(value) => setSearch(value)} />
        {isManager && (
          <PinnableOptionsButton
            options={SORT_OPTIONS}
            active={sortKey}
            pinned={pinnedSorts}
            onSelect={(key) => setSortKey(key as SortKey)}
            onTogglePin={(key) =>
              updatePrefs({
                pinnedProductSort: pinnedSorts.includes(key)
                  ? pinnedSorts.filter((k) => k !== key)
                  : [...pinnedSorts, key],
              })
            }
          />
        )}
        {isManager && (
          <AdjustViewPopover
            activeColumns={activeColumns}
            activeViewKey={preferences.productColumns ? undefined : activeView.key}
            customViews={customViews}
            insightDays={insightDays}
            onChangeInsightDays={changeInsightDays}
            onSelectView={(v) => updatePrefs({ productView: v.key, productColumns: v.columns })}
            onToggleColumn={(col) =>
              updatePrefs({
                productColumns: activeColumns.includes(col)
                  ? activeColumns.filter((c) => c !== col)
                  : [...activeColumns, col],
              })
            }
            onSaveCustom={(name) => {
              const key = `custom-${Date.now()}`;
              const next = [...customViews, { key, label: name, columns: activeColumns }];
              updatePrefs({ productCustomViews: next, productView: key, productColumns: undefined });
            }}
            onDeleteCustom={(key) => {
              const next = customViews.filter((v) => v.key !== key);
              const patch: Partial<typeof preferences> = { productCustomViews: next };
              if (preferences.productView === key) patch.productView = undefined;
              updatePrefs(patch);
            }}
          />
        )}
        <SegmentedControl
          layoutId="products-view-mode"
          value={view}
          onChange={setView}
          segments={VIEW_MODES.map(({ key, label, icon: Icon }) => ({
            key,
            title: `${label} view`,
            icon: <Icon size={16} />,
          }))}
        />
      </div>

      {isManager && pinnedSorts.length > 0 && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {SORT_OPTIONS.filter((s) => pinnedSorts.includes(s.key)).map((s) => (
            <button
              key={s.key}
              onClick={() => setSortKey(s.key)}
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
      ) : visibleProducts.length === 0 ? (
        <EmptyState icon={Package} title="No products found" />
      ) : view === "gallery" && galleryCategory === null && galleryFolders.length > 0 ? (
        // §iPhone mockup: Gallery opens on a grid of category folders,
        // three across on a phone. Tapping one drills into its products.
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {galleryFolders.map((f) => (
            <button
              key={f.name}
              onClick={() => setGalleryCategory(f.name)}
              className="flex flex-col items-center gap-1.5 group"
            >
              <div className="w-full aspect-square rounded-card bg-canvas border border-hairline grid place-items-center text-secondary group-hover:border-accent/50 group-hover:text-accent transition">
                <Folder size={40} strokeWidth={1.5} />
              </div>
              <span className="text-caption font-semibold text-center leading-tight line-clamp-2">
                {f.name}
              </span>
              <span className="text-[10px] text-secondary tabular-nums -mt-1">{f.count}</span>
            </button>
          ))}
        </div>
      ) : view === "gallery" ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {galleryCategory !== null && (
            <button
              onClick={() => setGalleryCategory(null)}
              className="sm:col-span-2 flex items-center gap-1.5 text-subhead font-semibold text-accent -mb-1 self-start"
            >
              <ChevronLeft size={16} /> All categories
            </button>
          )}
          {galleryProducts.map((p) => (
            <button
              key={p.id}
              onClick={() => openDetail(p)}
              className="text-left bg-surface border border-hairline rounded-card overflow-hidden hover:border-accent/50 transition flex"
            >
              <div className="w-36 h-36 bg-canvas relative shrink-0">
                <img
                  src={`/api/product-photo?sku=${encodeURIComponent(p.sku)}`}
                  alt={p.name}
                  className="w-full h-full object-cover"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  loading="lazy"
                />
              </div>
              <div className="p-4 flex flex-col justify-center min-w-0">
                <div className="text-caption font-semibold text-secondary">{p.sku}</div>
                <div className="text-headline font-semibold truncate">{p.name}</div>
                {p.category && <div className="text-caption text-secondary truncate mt-0.5">{p.category}</div>}
                <div className="text-title font-bold tabular-nums mt-2">{formatAed(p.price)}</div>
                {isManager && p.stock_on_hand != null && (
                  <div className="text-caption text-secondary tabular-nums mt-1">SOH: {p.stock_on_hand}</div>
                )}
                {isManager && (
                  <ExtraFieldsLine product={p} columns={activeColumns} insight={insights.get(p.id)} insightDays={insightDays} />
                )}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="bg-surface border border-hairline rounded-card overflow-x-auto">
          <table className="w-full text-subhead">
            <thead>
              <tr className="text-caption text-secondary uppercase text-left border-b border-hairline">
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums whitespace-nowrap">Price</th>
                {isManager &&
                  activeColumns.map((col) => (
                    <th key={col} className="px-4 py-3 font-medium text-right tabular-nums whitespace-nowrap">
                      {columnLabel(col, insightDays)}
                    </th>
                  ))}
                {isManager && <th className="px-4 py-3 font-medium text-right" aria-label="Edit" />}
              </tr>
            </thead>
            <tbody>
              {pagedProducts.map((p) => {
                const isExpanded = expandedId === p.id;
                const insight = insights.get(p.id);
                const figures = resolveProductFigures(p, insight);
                return (
                  <Fragment key={p.id}>
                    <tr
                      className="border-b border-hairline last:border-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.03] cursor-pointer"
                      onClick={() => toggleExpand(p)}
                    >
                      <td className="px-4 py-3 font-medium whitespace-nowrap">{p.sku}</td>
                      <td className="px-4 py-3">{p.name}</td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatAed(p.price)}</td>
                      {isManager &&
                        activeColumns.map((col) => (
                          <td key={col} className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                            {renderProductColumn(p, col, insight)}
                          </td>
                        ))}
                      {isManager && (
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditing(p);
                            }}
                            className="text-secondary hover:text-accent"
                            aria-label="Edit product"
                          >
                            <Pencil size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                    {isExpanded && (
                      <tr className="bg-canvas border-b border-hairline last:border-0">
                        <td colSpan={isManager ? 4 + activeColumns.length : 3} className="px-4 py-3">
                          {p.category && (
                            <div className="text-caption text-secondary mb-2">Category: {p.category}</div>
                          )}
                          {p.rack_location && (
                            <div className="text-caption text-secondary mb-2">Rack: {p.rack_location}</div>
                          )}
                          {isManager && (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              <ExpandStat label="VAC (landing cost)" value={figures.vac != null ? formatAed(figures.vac) : "—"} />
                              <ExpandStat label="VAC China (¥)" value={figures.vacChina != null ? `¥${figures.vacChina.toFixed(2)}` : "—"} />
                              <ExpandStat label="SAD (days since arrival)" value={figures.sad != null ? `${figures.sad}d` : "—"} />
                              <ExpandStat label="SHD (days of stock cover)" value={figures.shd != null ? `${figures.shd.toFixed(0)}d` : "—"} />
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination {...pager} noun="products" />

      {isManager && editing && (
        <ProductEditor
          // Without a key React reuses the same instance when you go from
          // editing a product straight to "Add product", so the useState
          // initializers never re-run and the new-product form opens
          // prefilled with the previous product's data.
          key={editing === "new" ? "new" : editing.id}
          product={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {viewing && (
        <ProductDetailSheet
          key={viewing.id}
          product={viewing}
          insight={insights.get(viewing.id)}
          isManager={isManager}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing);
            setViewing(null);
          }}
        />
      )}

    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead tabular-nums text-secondary">
        {value}
      </div>
    </div>
  );
}

// A figure that computes itself unless the manager types one. Empty means
// "use the computed value", and the computed value is shown as the
// placeholder so it's clear what you'd be overriding.
function OverrideField({
  label,
  value,
  derived,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  derived: string | null;
  suffix?: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="relative">
        <TextInput
          type="number"
          min="0"
          step="0.01"
          inputMode="decimal"
          value={value}
          placeholder={derived ?? "—"}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-caption text-secondary pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      <p className="text-caption text-secondary mt-1">
        {value.trim() !== ""
          ? `Overriding${derived ? ` computed ${derived}` : ""}`
          : derived
            ? `Computed: ${derived}`
            : "Not enough history to compute"}
      </p>
    </div>
  );
}

function ProductEditor({
  product,
  onClose,
  onSaved,
}: {
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    sku: product?.sku ?? "",
    name: product?.name ?? "",
    category: product?.category ?? "",
    price: product?.price ?? 0,
    cost: product?.cost ?? 0,
    default_qty: product?.default_qty ?? 12,
    rack_location: product?.rack_location ?? "",
    barcode: product?.barcode ?? "",
    stock_on_hand: product?.stock_on_hand ?? 0,
    is_active: product?.is_active ?? true,
    // Blank string = "no override, keep computing it".
    vac_override: product?.vac_override != null ? String(product.vac_override) : "",
    vac_china_override: product?.vac_china_override != null ? String(product.vac_china_override) : "",
    stock_arrival_date: product?.stock_arrival_date ?? "",
    stock_holding_days_override:
      product?.stock_holding_days_override != null ? String(product.stock_holding_days_override) : "",
  });
  const [saving, setSaving] = useState(false);
  // §Products: "when adding a new image during product creation, the
  // Additional Details section doesn't show — should follow the design."
  // The photo is uploaded on save (it's filed in Drive under the SKU, so it
  // needs the final SKU), and picking one reveals Additional Details.
  const [photo, setPhoto] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(!!product);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [categories, setCategories] = useState<string[]>([]);
  // VAC / VAC (China) / stock arrival + holding days are computed from
  // purchase history (purchases.landing_cost / china_cost / grn_date) and
  // stock ÷ avg monthly sold. `insight` is that computed baseline — it's
  // shown as the placeholder behind each override box so you can see what
  // you'd be replacing.
  const [insight, setInsight] = useState<ProductInsight | null>(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    fetchProducts(supabase, {})
      .then((all) => setCategories([...new Set(all.map((p) => p.category).filter(Boolean) as string[])].sort()))
      .catch(() => {});
    if (product) {
      fetchProductInsights(supabase, [product.id]).then((m) => setInsight(m.get(product.id) ?? null));
    }
  }, [product]);

  const grossProfit = (Number(form.price) || 0) - (Number(form.cost) || 0);
  const grossProfitPct = Number(form.price) > 0 ? Math.round((grossProfit / Number(form.price)) * 100) : 0;
  // Derived baseline only — the typed override lives in form state, so this
  // deliberately passes no override, and goes through the shared resolver so
  // its units can't drift from the list's again.
  const stockHoldingDays = resolveProductFigures(
    { stock_on_hand: Number(form.stock_on_hand) },
    insight ?? undefined
  ).shd;

  function choosePhoto(file: File) {
    setPhoto(file);
    setPhotoPreview(URL.createObjectURL(file));
    setShowDetails(true);
  }

  async function save() {
    setSaving(true);
    const supabase = supabaseBrowser();
    try {
      // An empty override box means "clear it, go back to computing this",
      // which is a real null write — not a field to omit.
      const num = (v: string) => (v.trim() === "" ? null : Number(v));
      const payload = {
        ...form,
        category: form.category || null,
        vac_override: num(form.vac_override),
        vac_china_override: num(form.vac_china_override),
        stock_arrival_date: form.stock_arrival_date || null,
        stock_holding_days_override: num(form.stock_holding_days_override),
      };
      const result = product
        ? await updateProduct(supabase, product.id, payload)
        : await createProduct(supabase, payload);
      if (result?.overridesDropped) {
        toast.error(
          "Saved. VAC, VAC (China), stock arrival date and stock holding days " +
            "couldn't be stored yet — ask your administrator to enable them, then enter them again."
        );
      }

      if (photo) {
        const body = new FormData();
        body.set("photo", photo);
        body.set("sku", form.sku.trim());
        const res = await fetch("/api/products/upload-photo", { method: "POST", body });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          // The product itself saved fine — surface the photo failure
          // without pretending the whole save failed.
          toast.error(`Product saved, but the photo didn't upload: ${data.error ?? "unknown error"}`);
        }
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={product ? "Edit product" : "Add product"}
      footer={
        <>
          <Button tier="plain" onClick={onClose}>Cancel</Button>
          <Button tier="primary" onClick={save} disabled={saving || !form.sku || !form.name}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <Label>Photo</Label>
      <input
        ref={photoInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) choosePhoto(f);
        }}
      />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => photoInputRef.current?.click()}
          className="w-20 h-20 rounded-card border border-dashed border-hairline grid place-items-center overflow-hidden shrink-0 hover:border-accent/50 transition-colors"
          aria-label={photoPreview ? "Change photo" : "Add photo"}
        >
          {photoPreview ? (
            <img src={photoPreview} alt="" className="w-full h-full object-cover" />
          ) : product ? (
            <img
              src={`/api/product-photo?sku=${encodeURIComponent(product.sku)}`}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
          ) : (
            <Plus size={18} className="text-secondary" />
          )}
        </button>
        <div className="text-caption text-secondary">
          {photo ? photo.name : "Filed in Drive under the SKU, so it shows on the product list."}
        </div>
      </div>

      {/* Card 1 — identity. Category sits here in the mockup, not down in
          Additional Details, and offers the existing categories. */}
      <div className="mt-4">
        <Label>SKU</Label>
        <TextInput value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        <Label>Description</Label>
        <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Label>Category</Label>
        <input
          list="product-categories"
          className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
          placeholder="Pick an existing category or create a new one"
          value={form.category}
          onChange={(e) => setForm({ ...form, category: e.target.value })}
        />
        <datalist id="product-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </div>

      {/* Card 2 — Details */}
      <div className="mt-5 pt-4 border-t border-hairline">
        <div className="text-headline font-bold mb-2">Details</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Price (AED)</Label>
            <TextInput type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
          </div>
          <div>
            <Label>Cost (AED)</Label>
            <TextInput type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} />
          </div>
        </div>
        {/* Computed from price − cost, with its margin on the right, as drawn. */}
        <Label>Gross Profit</Label>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-card border border-hairline bg-canvas">
          <span className="text-subhead tabular-nums">{grossProfit.toFixed(2)}</span>
          <span className="text-subhead text-secondary tabular-nums">{grossProfitPct}%</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Default quantity</Label>
            <TextInput type="number" value={form.default_qty} onChange={(e) => setForm({ ...form, default_qty: Number(e.target.value) })} />
          </div>
          <div>
            <Label>Stock on hand</Label>
            <TextInput type="number" value={form.stock_on_hand} onChange={(e) => setForm({ ...form, stock_on_hand: Number(e.target.value) })} />
          </div>
          <div>
            <Label>Rack</Label>
            <TextInput value={form.rack_location} onChange={(e) => setForm({ ...form, rack_location: e.target.value })} />
          </div>
          <div>
            <Label>Barcode</Label>
            <TextInput value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
          </div>
        </div>
      </div>

      {/* Card 3 — Additional Details. Each of the four is worked out from
          purchase and sales history by default; typing here overrides that
          one figure for this product. Clearing the box hands it back to the
          computed value. */}
      <div className="mt-5 pt-4 border-t border-hairline">
        <div className="text-headline font-bold mb-1">Additional Details</div>
        <p className="text-caption text-secondary mb-2">
          Worked out from purchase history and sales. Type a value to override
          it for this product; clear the box to go back to the computed one.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <OverrideField
            label="VAC"
            suffix="AED"
            value={form.vac_override}
            derived={insight?.vac != null ? formatAed(insight.vac) : null}
            onChange={(v) => setForm({ ...form, vac_override: v })}
          />
          <OverrideField
            label="VAC (China)"
            suffix="¥"
            value={form.vac_china_override}
            derived={insight?.vacChina != null ? `¥${insight.vacChina.toFixed(2)}` : null}
            onChange={(v) => setForm({ ...form, vac_china_override: v })}
          />
          <div>
            <Label>Stock arrival date</Label>
            <TextInput
              type="date"
              value={form.stock_arrival_date}
              onChange={(e) => setForm({ ...form, stock_arrival_date: e.target.value })}
            />
            <p className="text-caption text-secondary mt-1">
              {form.stock_arrival_date
                ? `${Math.max(0, Math.floor((Date.now() - new Date(form.stock_arrival_date).getTime()) / 86_400_000))} days ago`
                : insight?.sad != null
                  ? `Computed: ${insight.sad} days since last GRN`
                  : "No purchase history yet"}
            </p>
          </div>
          <OverrideField
            label="Stock holding days"
            value={form.stock_holding_days_override}
            derived={stockHoldingDays != null ? stockHoldingDays.toFixed(0) : null}
            onChange={(v) => setForm({ ...form, stock_holding_days_override: v })}
          />
        </div>
      </div>

      <label className="flex items-center justify-end gap-2 mt-5 text-subhead">
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Active
      </label>
    </Sheet>
  );
}

function renderProductColumn(p: Product, col: ColumnKey, insight?: ProductInsight): string {
  switch (col) {
    case "category":
      return p.category ?? "-";
    case "cost":
      return p.cost != null ? formatAed(p.cost) : "-";
    case "stock_on_hand":
      return p.stock_on_hand != null ? String(p.stock_on_hand) : "-";
    case "rack_location":
      return p.rack_location ?? "-";
    case "barcode":
      return p.barcode ?? "-";
    case "default_qty":
      return String(p.default_qty);
    case "vac": {
      const f = resolveProductFigures(p, insight);
      return f.vac != null ? formatAed(f.vac) : "-";
    }
    case "vacChina": {
      const f = resolveProductFigures(p, insight);
      return f.vacChina != null ? `¥${f.vacChina.toFixed(2)}` : "-";
    }
    case "sad": {
      const f = resolveProductFigures(p, insight);
      return f.sad != null ? `${f.sad}d` : "-";
    }
    case "shd": {
      const f = resolveProductFigures(p, insight);
      return f.shd != null ? `${f.shd.toFixed(0)}d` : "-";
    }
    case "sale":
      return insight ? formatAed(insight.sale90d) : "-";
    case "sold":
      return insight ? String(insight.sold90d) : "-";
    case "gp": {
      if (!insight) return "-";
      const unitCost = resolveProductFigures(p, insight).vac ?? p.cost ?? null;
      if (unitCost == null) return "-";
      const gp = insight.sale90d - unitCost * insight.sold90d;
      return formatAed(gp);
    }
  }
}

// Extra Adjust-View columns rendered as a compact line on Icon/Gallery/
// Column tiles (§Next Updates: "Adjust View must apply to ALL view types")
// — "stock_on_hand" is skipped since those tiles already show it as "SOH".
function ExtraFieldsLine({
  product,
  columns,
  insight,
  insightDays,
}: {
  product: Product;
  columns: ColumnKey[];
  insight?: ProductInsight;
  insightDays: number;
}) {
  const shown = columns.filter((c) => c !== "stock_on_hand");
  if (shown.length === 0) return null;
  return (
    <div className="text-caption text-secondary truncate mt-0.5">
      {shown.map((c) => `${columnLabel(c, insightDays)}: ${renderProductColumn(product, c, insight)}`).join(" · ")}
    </div>
  );
}

function ExpandStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-caption text-secondary">{label}</div>
      <div className="text-subhead font-semibold tabular-nums">{value}</div>
    </div>
  );
}

// Read-only product detail page (§Next Updates: "new product-detail page
// layout" + "zoomable enlarged product image on click") — reachable from
// every view (icon/gallery/column tiles), separate from the edit form so
// non-Managers can look up a product without an edit affordance in front
// of them, and so Managers get a deliberate "Edit" step rather than
// landing straight in a form.
function ProductDetailSheet({
  product,
  insight,
  isManager,
  onClose,
  onEdit,
}: {
  product: Product;
  insight: ProductInsight | undefined;
  isManager: boolean;
  onClose: () => void;
  onEdit: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const [lastSold, setLastSold] = useState<LastSoldPrice | null | undefined>(undefined);
  const photoUrl = `/api/product-photo?sku=${encodeURIComponent(product.sku)}`;

  useEffect(() => {
    if (!isManager) return;
    setLastSold(undefined);
    fetchLastSoldPrice(supabaseBrowser(), product.id).then(setLastSold);
  }, [isManager, product.id]);

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={product.sku}
        footer={isManager ? <Button tier="primary" onClick={onEdit}>Edit product</Button> : undefined}
      >
        <button
          onClick={() => setZoomed(true)}
          className="w-full aspect-square bg-canvas rounded-card overflow-hidden mb-4 cursor-zoom-in"
          aria-label="Zoom product image"
        >
          <img
            src={photoUrl}
            alt={product.name}
            className="w-full h-full object-cover"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
          />
        </button>

        {/* Same three cards as the editor, read-only — the mockup's detail
            view is the edit form with the fields locked. */}
        <div>
          <Label>SKU</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">{product.sku}</div>
          <Label>Description</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">{product.name}</div>
          <Label>Category</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">
            {product.category ?? "—"}
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-hairline">
          <div className="text-headline font-bold mb-2">Details</div>
          <div className="grid grid-cols-2 gap-3">
            <ReadOnlyField label="Price (AED)" value={formatAed(product.price)} />
            {isManager && <ReadOnlyField label="Cost (AED)" value={product.cost != null ? formatAed(product.cost) : "—"} />}
          </div>
          {isManager && product.cost != null && (
            <>
              <Label>Gross Profit</Label>
              <div className="flex items-center justify-between px-3.5 py-2.5 rounded-card border border-hairline bg-canvas">
                <span className="text-subhead tabular-nums">{(product.price - product.cost).toFixed(2)}</span>
                <span className="text-subhead text-secondary tabular-nums">
                  {product.price > 0 ? Math.round(((product.price - product.cost) / product.price) * 100) : 0}%
                </span>
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <ReadOnlyField label="Default quantity" value={String(product.default_qty ?? "—")} />
            {isManager && (
              <ReadOnlyField label="Stock on hand" value={product.stock_on_hand != null ? String(product.stock_on_hand) : "—"} />
            )}
            <ReadOnlyField label="Rack" value={product.rack_location ?? "—"} />
            <ReadOnlyField label="Barcode" value={product.barcode ?? "—"} />
          </div>
          {isManager && lastSold !== undefined && (
            <p className="text-caption text-secondary mt-2">
              {lastSold
                ? `Last sold at ${formatAed(lastSold.price)}${lastSold.customerName ? ` to ${lastSold.customerName}` : ""} on ${new Date(lastSold.date).toLocaleDateString()}`
                : "Not sold yet"}
            </p>
          )}
        </div>

        {isManager && (
          <div className="mt-5 pt-4 border-t border-hairline">
            <div className="text-headline font-bold mb-1">Additional Details</div>
            <p className="text-caption text-secondary mb-2">
              Worked out from purchase history and sales, unless a value was
              entered by hand — those are marked.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const f = resolveProductFigures(product, insight ?? undefined);
                const mark = (on: boolean) => (on ? " (entered)" : "");
                return (
                  <>
                    <ReadOnlyField
                      label={`VAC${mark(f.overridden.vac)}`}
                      value={f.vac != null ? formatAed(f.vac) : "—"}
                    />
                    <ReadOnlyField
                      label={`VAC (China)${mark(f.overridden.vacChina)}`}
                      value={f.vacChina != null ? `¥${f.vacChina.toFixed(2)}` : "—"}
                    />
                    <ReadOnlyField
                      label={`Stock arrival days${mark(f.overridden.sad)}`}
                      value={f.sad != null ? String(f.sad) : "—"}
                    />
                    <ReadOnlyField
                      label={`Stock holding days${mark(f.overridden.shd)}`}
                      value={f.shd != null ? f.shd.toFixed(0) : "—"}
                    />
                  </>
                );
              })()}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-5 text-subhead">
          <span className={product.is_active ? "text-accent font-semibold" : "text-secondary"}>
            {product.is_active ? "Active" : "Inactive"}
          </span>
        </div>
      </Sheet>

      {zoomed && (
        <div
          className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setZoomed(false)}
        >
          <img
            src={photoUrl}
            alt={product.name}
            className="max-w-full max-h-full object-contain rounded-card"
          />
        </div>
      )}
    </>
  );
}
