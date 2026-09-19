"use client";

import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import { Fragment, useEffect, useState, useCallback, useMemo, useRef } from "react";
import { List, Search, Plus, Package, GalleryHorizontal, Images, Pencil, SlidersHorizontal, Folder, ChevronLeft } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchProducts, createProduct, updateProduct, fetchProductInsights, fetchLastSoldPrice, resolveProductFigures, linkStock, unlinkStock, type ProductInsight, type LastSoldPrice, type StockGroupMember } from "@/lib/queries/products";
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
import ScanArticlesButton from "./ScanArticlesButton";
import { PRODUCT_ALIASES } from "@/lib/importAliases";
import { usePreferences } from "@/lib/hooks/usePreferences";
import type { AppUser } from "@/lib/types/db";
import NewOrderSheet from "@/components/orders/NewOrderSheet";
import DrivePhotoBrowser from "./DrivePhotoBrowser";
import PinnableOptionsButton from "@/components/ui/PinnableOptions";
import { usePagination, Pagination } from "@/components/ui/Pagination";
import SegmentedControl from "@/components/ui/SegmentedControl";
import { PRODUCT_SAMPLE_EXAMPLE, PRODUCT_SAMPLE_HEADERS } from "@/lib/importSamples";

type SortKey = "none" | "sku" | "price_asc" | "price_desc" | "stock_asc" | "lowStock";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "sku", label: t("products.sortSku") },
  { key: "price_asc", label: t("products.sortPriceAsc") },
  { key: "price_desc", label: t("products.sortPriceDesc") },
  { key: "stock_asc", label: t("products.sortStockAsc") },
  { key: "lowStock", label: t("products.sortLowStock") },
];

type ViewMode = "list" | "gallery" | "photos";
const VIEW_MODES: { key: ViewMode; label: string; icon: typeof List }[] = [
  { key: "list", label: t("products.viewModeList"), icon: List },
  { key: "gallery", label: t("products.viewModeGallery"), icon: GalleryHorizontal },
  // The Drive photo library, browsed as folders — an extra way in alongside
  // List and Gallery, not a replacement for either.
  { key: "photos", label: t("products.viewModePhotos"), icon: Images },
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
  category: t("products.category"),
  cost: t("products.cost"),
  stock_on_hand: t("products.stockOnHand"),
  rack_location: t("products.rack"),
  barcode: t("products.barcode"),
  default_qty: t("products.defaultQty"),
  vac: t("products.vac"),
  vacChina: t("products.vacChina"),
  sad: t("products.sad"),
  shd: t("products.shd"),
  sale: t("products.sale"),
  sold: t("products.sold"),
  gp: t("products.gp"),
};

const INSIGHT_DAY_OPTIONS = [30, 60, 90] as const;

// Sale/Sold column headers carry the active lookback window (§Products:
// "Adjust View columns need date/time range adjustability").
function columnLabel(col: ColumnKey, days: number): string {
  if (col === "sale" || col === "sold")
    return t("products.columnWithWindow", { label: COLUMN_LABELS[col], days });
  return COLUMN_LABELS[col];
}
const PRODUCT_VIEWS: { key: string; label: string; columns: ColumnKey[] }[] = [
  // §Products mockup draws the default list as SKU / Description / Price /
  // VAC / GP / Sale / Sold / Stock. The insight columns are batch-fetched
  // for the rows on screen only (capped at 150), so this stays affordable
  // on the full catalogue.
  { key: "default", label: t("products.presetDefault"), columns: ["vac", "gp", "sale", "sold", "stock_on_hand"] },
  { key: "stockMovement", label: t("products.presetStockMovement"), columns: ["stock_on_hand", "rack_location", "default_qty"] },
  { key: "pricing", label: t("products.presetPricing"), columns: ["cost"] },
  { key: "salesInsight", label: t("products.presetSalesInsight"), columns: ["sale", "sold", "gp", "shd"] },
  { key: "all", label: t("products.presetAllColumns"), columns: ALL_COLUMNS },
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
        aria-label={t("products.adjustView")}
        title={t("products.adjustView")}
      >
        <SlidersHorizontal size={16} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute end-0 mt-2 w-72 glass rounded-card shadow-floating z-20 p-3">
            <div className="text-caption text-secondary font-semibold mb-1.5">{t("products.defaultViews")}</div>
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
                <div className="text-caption text-secondary font-semibold mb-1.5">{t("products.yourPresets")}</div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {customViews.map((v) => (
                    <span key={v.key} className="inline-flex items-center">
                      <button
                        onClick={() => onSelectView(v)}
                        className={`ps-2.5 pe-1.5 py-1 rounded-l-card text-caption font-medium border ${
                          activeViewKey === v.key ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                        }`}
                      >
                        {v.label}
                      </button>
                      <button
                        onClick={() => onDeleteCustom(v.key)}
                        aria-label={t("products.deletePreset", { name: v.label })}
                        className={`pe-2 ps-0.5 py-1 rounded-r-card text-caption border border-l-0 ${
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

            <div className="text-caption text-secondary font-semibold mb-1.5">{t("products.columns")}</div>
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
                <div className="text-caption text-secondary font-semibold mb-1.5">{t("products.saleSoldWindow")}</div>
                <div className="flex gap-1.5">
                  {INSIGHT_DAY_OPTIONS.map((d) => (
                    <button
                      key={d}
                      onClick={() => onChangeInsightDays(d)}
                      className={`flex-1 px-2 py-1 rounded-inner text-caption font-medium border ${
                        insightDays === d ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
                      }`}
                    >
                      {t("products.daysShort", { days: d })}
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
                    placeholder={t("products.presetName")}
                    className="flex-1 min-w-0 px-2 py-1 rounded-inner border border-hairline bg-canvas text-caption"
                  />
                  <Button tier="tinted" onClick={savePreset}>{t("common.save")}</Button>
                </div>
              ) : (
                <Button
                  tier="tinted"
                  onClick={() => setNamingPreset(true)}
                  className="w-full"
                >
                  {t("products.saveCurrentAsPreset")}
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function ProductsView({ isManager, user }: { isManager: boolean; user: AppUser }) {
  const [view, setView] = useState<ViewMode>("list");
  // Products for an order are picked here, where the photos, prices and stock
  // are, rather than through a search box inside the order sheet.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [orderFrom, setOrderFrom] = useState<Product[] | null>(null);
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

  // Two passes on purpose. The first screenful arrives on its own and the
  // page is usable straight away; the rest of the catalogue follows and
  // replaces it a moment later, so search, sort and the filters still work
  // across everything. A thousand rows in one go is what made this page sit
  // there doing nothing.
  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const term = search || undefined;

    const firstPage = await fetchProducts(supabase, { search: term, limit: 50 });
    setProducts(firstPage);
    setLoading(false);

    if (firstPage.length === 50) {
      const everything = await fetchProducts(supabase, { search: term });
      // A newer search may have landed while this was in flight.
      setProducts((current) => (current === firstPage ? everything : current));
    }
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

  function toggleSelected(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
        <h1 className="text-large-title font-bold">{t("nav.products")}</h1>
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
                headers: PRODUCT_SAMPLE_HEADERS,
            example: PRODUCT_SAMPLE_EXAMPLE,
              }}
            />
          )}
        {isManager && <ExportLink type="products" />}
          {/* A supplier invoice read straight into the catalogue, so a
              delivery of new lines doesn't have to be typed twice. */}
          {isManager && <ScanArticlesButton onAdded={load} />}
          {isManager && (
            <Button tier="primary" onClick={() => setEditing("new")} className="flex items-center gap-1.5">
              <Plus size={16} /> {t("products.addProduct")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            className="w-full ps-9 pe-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
            placeholder={t("products.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <BarcodeScanButton onScan={(value) => setSearch(value)} />
        <button
          onClick={() => {
            setSelecting((v) => !v);
            setSelected([]);
          }}
          aria-pressed={selecting}
          className={`px-3 py-2 rounded-card border text-caption font-semibold whitespace-nowrap transition-colors ${
            selecting ? "bg-accent text-white border-accent" : "border-hairline text-secondary hover:text-primary"
          }`}
        >
          {selecting ? t("common.cancel") : t("products.select")}
        </button>
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
            title: t("products.viewModeTitle", { label }),
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

      {view === "photos" ? (
        // Browses the Drive folder tree itself, the way the phone's
        // PhotoBrowserView does. It is not driven by the catalogue list —
        // hence its own loading/empty handling and its own search box — but
        // what it picks goes into the same NewOrderSheet the other views use.
        <DrivePhotoBrowser onStartOrder={(picked) => setOrderFrom(picked)} />
      ) : loading ? (
        <SkeletonList rows={6} />
      ) : visibleProducts.length === 0 ? (
        <EmptyState icon={Package} title={t("products.noneFound")} />
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
              <ChevronLeft size={16} /> {t("products.allCategories")}
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
                  src={`/api/product-photo?sku=${encodeURIComponent(p.sku)}&w=288`}
                  alt={p.name}
                  className="w-full h-full object-cover"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                  loading="lazy"
                  decoding="async"
                />
              </div>
              <div className="p-4 flex flex-col justify-center min-w-0">
                <div className="text-caption font-semibold text-secondary">{p.sku}</div>
                <div className="text-headline font-semibold truncate">{p.name}</div>
                {p.category && <div className="text-caption text-secondary truncate mt-0.5">{p.category}</div>}
                <div className="text-title font-bold tabular-nums mt-2">{formatAed(p.price)}</div>
                {isManager && p.stock_on_hand != null && (
                  <div className="text-caption text-secondary tabular-nums mt-1">{t("products.sohWithColon", { value: p.stock_on_hand })}</div>
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
                {selecting && (
                  <th className="ps-4 py-3 font-medium">
                    <input
                      type="checkbox"
                      aria-label={t("products.selectAllOnPage")}
                      checked={pagedProducts.length > 0 && pagedProducts.every((p) => selected.includes(p.id))}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? // Add this page to whatever is already picked, so
                              // paging through does not lose earlier choices.
                              [...new Set([...selected, ...pagedProducts.map((p) => p.id)])]
                            : selected.filter((id) => !pagedProducts.some((p) => p.id === id))
                        )
                      }
                    />
                  </th>
                )}
                <th className="px-4 py-3 font-medium">{t("products.sku")}</th>
                <th className="px-4 py-3 font-medium">{t("products.name")}</th>
                <th className="px-4 py-3 font-medium text-right tabular-nums whitespace-nowrap">{t("products.price")}</th>
                {/* Managers reach stock through their configurable columns;
                    everyone else gets it here, because knowing whether there
                    is any is not a manager-only concern. */}
                {!isManager && (
                  <th className="px-4 py-3 font-medium text-right tabular-nums whitespace-nowrap">{t("products.stock")}</th>
                )}
                {isManager &&
                  activeColumns.map((col) => (
                    <th key={col} className="px-4 py-3 font-medium text-right tabular-nums whitespace-nowrap">
                      {columnLabel(col, insightDays)}
                    </th>
                  ))}
                {isManager && <th className="px-4 py-3 font-medium text-right" aria-label={t("common.edit")} />}
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
                      onClick={() => (selecting ? toggleSelected(p.id) : toggleExpand(p))}
                    >
                      {selecting && (
                        <td className="ps-4 py-3">
                          <input
                            type="checkbox"
                            checked={selected.includes(p.id)}
                            onChange={() => toggleSelected(p.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={t("products.selectSku", { sku: p.sku })}
                          />
                        </td>
                      )}
                      <td className="px-4 py-3 font-medium whitespace-nowrap">{p.sku}</td>
                      <td className="px-4 py-3">{p.name}</td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{formatAed(p.price)}</td>
                      {!isManager && (
                        <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                          {p.stock_on_hand ?? t("common.notSet")}
                        </td>
                      )}
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
                            aria-label={t("products.editProduct")}
                          >
                            <Pencil size={14} />
                          </button>
                        </td>
                      )}
                    </tr>
                    {isExpanded && (
                      <tr className="bg-canvas border-b border-hairline last:border-0">
                        <td
                          // SKU, name, price, then either the manager's
                          // configurable columns plus the edit cell, or the
                          // stock column everyone else gets. The tick column
                          // counts too while selecting.
                          colSpan={
                            (isManager ? 4 + activeColumns.length : 4) + (selecting ? 1 : 0)
                          }
                          className="px-4 py-3"
                        >
                          {p.category && (
                            <div className="text-caption text-secondary mb-2">{t("products.categoryWithValue", { value: p.category })}</div>
                          )}
                          {p.rack_location && (
                            <div className="text-caption text-secondary mb-2">{t("products.rackWithValue", { value: p.rack_location })}</div>
                          )}
                          {isManager && (
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                              <ExpandStat label={t("products.vacLandingCost")} value={figures.vac != null ? formatAed(figures.vac) : t("common.notSet")} />
                              <ExpandStat label={t("products.vacChinaYen")} value={figures.vacChina != null ? `¥${figures.vacChina.toFixed(2)}` : t("common.notSet")} />
                              <ExpandStat label={t("products.sadDaysSinceArrival")} value={figures.sad != null ? t("products.daysShort", { days: figures.sad }) : t("common.notSet")} />
                              <ExpandStat label={t("products.shdDaysOfCover")} value={figures.shd != null ? t("products.daysShort", { days: figures.shd.toFixed(0) }) : t("common.notSet")} />
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

      {/* Paging belongs to the catalogue list; the Drive browser pages its
          own folders. */}
      {view !== "photos" && <Pagination {...pager} noun={t("products.nounPlural")} />}

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
          // Sharing stock is written the moment it's picked, not on Save, so
          // the list behind the sheet is refreshed straight away — Cancel
          // afterwards must not leave it showing the old grouping.
          onLinksChanged={load}
        />
      )}

      {/* Sits above the list while picking, so the count and the way out are
          always in reach rather than at the bottom of 1,300 rows. */}
      {/* Hidden in the Drive browser, which puts its own picked-photo bar in
          the same place — two bars would sit on top of each other. */}
      {view !== "photos" && selecting && selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pointer-events-none">
          <div className="max-w-[1600px] mx-auto flex justify-center">
            <div className="pointer-events-auto flex items-center gap-4 px-4 py-3 rounded-full shadow-overlay bg-surface border border-hairline">
              <span className="text-subhead font-semibold tabular-nums">
                {t("products.nSelected", { n: selected.length })}
              </span>
              <button
                onClick={() => setSelected([])}
                className="text-caption text-secondary hover:text-primary"
              >
                {t("products.clear")}
              </button>
              <button
                onClick={() => {
                  const picked = products.filter((p) => selected.includes(p.id));
                  if (picked.length === 0) return;
                  setOrderFrom(picked);
                }}
                className="px-4 py-2 rounded-full bg-accent text-white text-caption font-semibold"
              >
                {t("products.startOrder")}
              </button>
            </div>
          </div>
        </div>
      )}

      {orderFrom && (
        <NewOrderSheet
          user={user}
          initialProducts={orderFrom}
          onClose={() => setOrderFrom(null)}
          onCreated={() => {
            setOrderFrom(null);
            setSelecting(false);
            setSelected([]);
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
          placeholder={derived ?? t("common.notSet")}
          onChange={(e) => onChange(e.target.value)}
        />
        {suffix && (
          <span className="absolute end-3 top-1/2 -translate-y-1/2 text-caption text-secondary pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
      <p className="text-caption text-secondary mt-1">
        {value.trim() !== ""
          ? derived
            ? t("products.overridingComputed", { value: derived })
            : t("products.overriding")
          : derived
            ? t("products.computedValue", { value: derived })
            : t("products.notEnoughHistory")}
      </p>
    </div>
  );
}

function ProductEditor({
  product,
  onClose,
  onSaved,
  onLinksChanged,
}: {
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
  onLinksChanged: () => void;
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
  // Shared stock. `members` is every other product on this product's shelf;
  // `catalogue` is what the search box below picks from. Linking writes at
  // once (it touches two rows and the database adopts the figure), so it is
  // not part of the form that Save sends.
  const [catalogue, setCatalogue] = useState<Product[]>([]);
  const [members, setMembers] = useState<StockGroupMember[]>([]);
  const [linkSearch, setLinkSearch] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  /// Set when the product picked is already on somebody else's shelf, so the
  /// move has to be agreed to before it happens.
  const [pendingMove, setPendingMove] = useState<
    { picked: Product; sku: string; movingFrom: string[] } | null
  >(null);

  useEffect(() => {
    const supabase = supabaseBrowser();
    fetchProducts(supabase, {})
      .then((all) => {
        setCatalogue(all);
        setCategories([...new Set(all.map((p) => p.category).filter(Boolean) as string[])].sort());
      })
      .catch(() => {});
    if (product) {
      fetchProductInsights(supabase, [product.id]).then((m) => setInsight(m.get(product.id) ?? null));
      if (product.stock_group_id) {
        fetchProducts(supabase, { stockGroupId: product.stock_group_id, activeOnly: false })
          .then((group) => setMembers(group.filter((p) => p.id !== product.id)))
          .catch(() => {});
      }
    }
  }, [product]);

  // Candidates to put under this stock: anything in the catalogue that is
  // not this product and not already on the shelf. Capped so the sheet
  // stays a sheet and not a second product list.
  const linkCandidates = useMemo(() => {
    const term = linkSearch.trim().toLowerCase();
    if (!term || !product) return [];
    const taken = new Set([product.id, ...members.map((m) => m.id)]);
    return catalogue
      .filter((p) => !taken.has(p.id))
      .filter((p) => p.sku.toLowerCase().includes(term) || p.name.toLowerCase().includes(term))
      .slice(0, 8);
  }, [linkSearch, catalogue, members, product]);

  // The picked product joins THIS product's stock and takes this product's
  // figure — "add another product under the same shared stock". Shown at
  // once, taken back if the write fails.
  async function addUnderThisStock(picked: Product, confirmMove = false) {
    if (!product || linkBusy) return;
    const before = members;
    // Shown at once, taken back if the server refuses or asks a question.
    setMembers([...before, { id: picked.id, sku: picked.sku, stock_on_hand: product.stock_on_hand }]);
    setLinkSearch("");
    setLinkBusy(true);
    try {
      const result = await linkStock(picked.id, product.id, confirmMove);
      if (!result.linked) {
        // It already shares a shelf with somebody. Put the list back as it
        // was and ask, rather than quietly taking it off theirs.
        setMembers(before);
        setPendingMove({ picked, ...result.confirm });
        return;
      }
      setMembers(result.members.filter((m) => m.id !== product.id));
      setPendingMove(null);
      onLinksChanged();
    } catch (e) {
      setMembers(before);
      toast.error(e instanceof Error ? e.message : t("products.shareStockFailed"));
    } finally {
      setLinkBusy(false);
    }
  }

  // Taking a product off the shelf: it keeps today's figure and counts on
  // its own from here. `id` may be this product itself, which clears the
  // whole list from this side.
  async function takeOffThisStock(id: string) {
    if (!product || linkBusy) return;
    const before = members;
    setMembers(id === product.id ? [] : before.filter((m) => m.id !== id));
    setLinkBusy(true);
    try {
      await unlinkStock(id);
      onLinksChanged();
    } catch (e) {
      setMembers(before);
      toast.error(e instanceof Error ? e.message : t("products.stopSharingStockFailed"));
    } finally {
      setLinkBusy(false);
    }
  }

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
        toast.error(t("products.overridesDropped"));
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
          toast.error(
            t("products.photoUploadFailed", { error: data.error ?? t("products.unknownErrorLower") })
          );
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
      title={product ? t("products.editProduct") : t("products.addProduct")}
      footer={
        <>
          <Button tier="plain" onClick={onClose}>{t("common.cancel")}</Button>
          <Button tier="primary" onClick={save} disabled={saving || !form.sku || !form.name}>
            {saving ? t("common.saving") : t("common.save")}
          </Button>
        </>
      }
    >
      <Label>{t("products.photo")}</Label>
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
          aria-label={photoPreview ? t("products.changePhoto") : t("products.addPhoto")}
        >
          {photoPreview ? (
            <img src={photoPreview} alt="" className="w-full h-full object-cover" />
          ) : product ? (
            <img
              src={`/api/product-photo?sku=${encodeURIComponent(product.sku)}&w=256`}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
            />
          ) : (
            <Plus size={18} className="text-secondary" />
          )}
        </button>
        <div className="text-caption text-secondary">
          {photo ? photo.name : t("products.photoHint")}
        </div>
      </div>

      {/* Card 1 — identity. Category sits here in the mockup, not down in
          Additional Details, and offers the existing categories. */}
      <div className="mt-4">
        <Label>{t("products.sku")}</Label>
        <TextInput value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} />
        <Label>{t("products.description")}</Label>
        <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Label>{t("products.category")}</Label>
        <input
          list="product-categories"
          className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
          placeholder={t("products.categoryPlaceholder")}
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
        <div className="text-headline font-bold mb-2">{t("products.details")}</div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("products.priceAed")}</Label>
            <TextInput type="number" value={form.price} onChange={(e) => setForm({ ...form, price: Number(e.target.value) })} />
          </div>
          <div>
            <Label>{t("products.costAed")}</Label>
            <TextInput type="number" value={form.cost} onChange={(e) => setForm({ ...form, cost: Number(e.target.value) })} />
          </div>
        </div>
        {/* Computed from price − cost, with its margin on the right, as drawn. */}
        <Label>{t("products.grossProfit")}</Label>
        <div className="flex items-center justify-between px-3.5 py-2.5 rounded-card border border-hairline bg-canvas">
          <span className="text-subhead tabular-nums">{grossProfit.toFixed(2)}</span>
          <span className="text-subhead text-secondary tabular-nums">{grossProfitPct}%</span>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>{t("products.defaultQuantity")}</Label>
            <TextInput type="number" value={form.default_qty} onChange={(e) => setForm({ ...form, default_qty: Number(e.target.value) })} />
          </div>
          <div>
            <Label>{t("products.stockOnHand")}</Label>
            <TextInput type="number" min={0} value={form.stock_on_hand} onChange={(e) => setForm({ ...form, stock_on_hand: Math.max(0, Number(e.target.value) || 0) })} />
          </div>
          <div>
            <Label>{t("products.rack")}</Label>
            <TextInput value={form.rack_location} onChange={(e) => setForm({ ...form, rack_location: e.target.value })} />
          </div>
          <div>
            <Label>{t("products.barcode")}</Label>
            <TextInput value={form.barcode} onChange={(e) => setForm({ ...form, barcode: e.target.value })} />
          </div>
        </div>

        {/* Shared stock — other SKUs that are the same physical shelf. Only
            for a saved product: linking needs an id on both sides. */}
        {product && (
          <div>
            <Label>{t("products.sharedStock")}</Label>
            <p className="text-caption text-secondary mb-2">
              {t("products.sharedStockHint")}
            </p>
            {members.length > 0 && (
              <ul className="rounded-card border border-hairline bg-canvas divide-y divide-hairline mb-2">
                {members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-3 ps-3.5 pe-1 min-h-11">
                    <span className="text-subhead truncate">{m.sku}</span>
                    <Button
                      tier="plain"
                      type="button"
                      className="min-h-11 shrink-0"
                      disabled={linkBusy}
                      onClick={() => takeOffThisStock(m.id)}
                      aria-label={t("products.stopSharingWith", { sku: m.sku })}
                    >
                      {t("common.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <TextInput
              value={linkSearch}
              placeholder={t("products.linkStockPlaceholder")}
              disabled={linkBusy}
              onChange={(e) => setLinkSearch(e.target.value)}
              aria-label={t("products.linkStockLabel")}
            />
            {linkCandidates.length > 0 && (
              <ul className="rounded-card border border-hairline bg-surface divide-y divide-hairline mt-1 overflow-hidden">
                {linkCandidates.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      className="w-full flex items-center justify-between gap-3 px-3.5 min-h-11 text-start hover:bg-primary/[0.04] transition-colors"
                      onClick={() => addUnderThisStock(p)}
                    >
                      <span className="text-subhead truncate">
                        <span className="font-semibold">{p.sku}</span>
                        <span className="text-secondary"> · {p.name}</span>
                      </span>
                      <span className="text-caption text-secondary tabular-nums shrink-0">
                        {t("products.soh", { value: p.stock_on_hand ?? t("common.notSet") })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {linkSearch.trim() !== "" && linkCandidates.length === 0 && !pendingMove && (
              <p className="text-caption text-secondary mt-1">{t("products.noOtherProductMatches")}</p>
            )}

            {/* The product picked already shares a shelf with somebody. Say
                whose, and let them decide — a shelf is a physical thing and
                taking a SKU off one is not what "add" sounds like. */}
            {pendingMove && (
              <div
                role="alertdialog"
                aria-live="polite"
                className="mt-2 rounded-card border border-[--status-warning] bg-[--status-warning]/10 p-3"
              >
                <p className="text-subhead font-semibold">
                  {t("products.moveShelfTitle", { sku: pendingMove.sku })}
                </p>
                <p className="text-caption text-secondary mt-1">
                  {t("products.moveShelfBody", {
                    sku: pendingMove.sku,
                    partners: pendingMove.movingFrom.join(", "),
                  })}
                </p>
                <div className="flex items-center justify-end gap-2 mt-2.5">
                  <Button
                    tier="plain"
                    type="button"
                    className="min-h-11"
                    disabled={linkBusy}
                    onClick={() => setPendingMove(null)}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    tier="primary"
                    type="button"
                    className="min-h-11"
                    disabled={linkBusy}
                    onClick={() => addUnderThisStock(pendingMove.picked, true)}
                  >
                    {t("products.moveShelfConfirm")}
                  </Button>
                </div>
              </div>
            )}
            {members.length > 0 && (
              <Button
                tier="plain"
                type="button"
                className="mt-1 min-h-11"
                disabled={linkBusy}
                onClick={() => takeOffThisStock(product.id)}
              >
                {t("products.takeOffSharedStock")}
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Card 3 — Additional Details. Each of the four is worked out from
          purchase and sales history by default; typing here overrides that
          one figure for this product. Clearing the box hands it back to the
          computed value. */}
      <div className="mt-5 pt-4 border-t border-hairline">
        <div className="text-headline font-bold mb-1">{t("products.additionalDetails")}</div>
        <p className="text-caption text-secondary mb-2">
          {t("products.additionalDetailsHint")}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <OverrideField
            label={t("products.vac")}
            suffix="AED"
            value={form.vac_override}
            derived={insight?.vac != null ? formatAed(insight.vac) : null}
            onChange={(v) => setForm({ ...form, vac_override: v })}
          />
          <OverrideField
            label={t("products.vacChinaParen")}
            suffix="¥"
            value={form.vac_china_override}
            derived={insight?.vacChina != null ? `¥${insight.vacChina.toFixed(2)}` : null}
            onChange={(v) => setForm({ ...form, vac_china_override: v })}
          />
          <div>
            <Label>{t("products.stockArrivalDate")}</Label>
            <TextInput
              type="date"
              value={form.stock_arrival_date}
              onChange={(e) => setForm({ ...form, stock_arrival_date: e.target.value })}
            />
            <p className="text-caption text-secondary mt-1">
              {form.stock_arrival_date
                ? t("products.daysAgo", {
                    days: Math.max(0, Math.floor((Date.now() - new Date(form.stock_arrival_date).getTime()) / 86_400_000)),
                  })
                : insight?.sad != null
                  ? t("products.computedDaysSinceGrn", { days: insight.sad })
                  : t("products.noPurchaseHistory")}
            </p>
          </div>
          <OverrideField
            label={t("products.stockHoldingDays")}
            value={form.stock_holding_days_override}
            derived={stockHoldingDays != null ? stockHoldingDays.toFixed(0) : null}
            onChange={(v) => setForm({ ...form, stock_holding_days_override: v })}
          />
        </div>
      </div>

      <label className="flex items-center justify-end gap-2 mt-5 text-subhead">
        <input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        {t("products.active")}
      </label>
    </Sheet>
  );
}

function renderProductColumn(p: Product, col: ColumnKey, insight?: ProductInsight): string {
  switch (col) {
    case "category":
      return p.category ?? t("products.noValue");
    case "cost":
      return p.cost != null ? formatAed(p.cost) : t("products.noValue");
    case "stock_on_hand":
      return p.stock_on_hand != null ? String(p.stock_on_hand) : t("products.noValue");
    case "rack_location":
      return p.rack_location ?? t("products.noValue");
    case "barcode":
      return p.barcode ?? t("products.noValue");
    case "default_qty":
      return String(p.default_qty);
    case "vac": {
      const f = resolveProductFigures(p, insight);
      return f.vac != null ? formatAed(f.vac) : t("products.noValue");
    }
    case "vacChina": {
      const f = resolveProductFigures(p, insight);
      return f.vacChina != null ? `¥${f.vacChina.toFixed(2)}` : t("products.noValue");
    }
    case "sad": {
      const f = resolveProductFigures(p, insight);
      return f.sad != null ? t("products.daysShort", { days: f.sad }) : t("products.noValue");
    }
    case "shd": {
      const f = resolveProductFigures(p, insight);
      return f.shd != null ? t("products.daysShort", { days: f.shd.toFixed(0) }) : t("products.noValue");
    }
    case "sale":
      return insight ? formatAed(insight.sale90d) : t("products.noValue");
    case "sold":
      return insight ? String(insight.sold90d) : t("products.noValue");
    case "gp": {
      if (!insight) return t("products.noValue");
      const unitCost = resolveProductFigures(p, insight).vac ?? p.cost ?? null;
      if (unitCost == null) return t("products.noValue");
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
      {shown
        .map((c) =>
          t("products.columnLabelValue", {
            label: columnLabel(c, insightDays),
            value: renderProductColumn(product, c, insight),
          })
        )
        .join(" · ")}
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
  // The other SKUs on this product's shelf, if it shares one. Everyone who
  // may see the stock figure may see whose it also is.
  const [sharedWith, setSharedWith] = useState<string[]>([]);
  // The sheet shows one photo large and zooms it, so this is the one place
  // that genuinely wants the original.
  const photoUrl = `/api/product-photo?sku=${encodeURIComponent(product.sku)}`;

  useEffect(() => {
    if (!isManager) return;
    setLastSold(undefined);
    fetchLastSoldPrice(supabaseBrowser(), product.id).then(setLastSold);
  }, [isManager, product.id]);

  useEffect(() => {
    setSharedWith([]);
    if (!product.stock_group_id) return;
    fetchProducts(supabaseBrowser(), { stockGroupId: product.stock_group_id, activeOnly: false })
      .then((group) => setSharedWith(group.filter((p) => p.id !== product.id).map((p) => p.sku)))
      .catch(() => {});
  }, [product.id, product.stock_group_id]);

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title={product.sku}
        footer={isManager ? <Button tier="primary" onClick={onEdit}>{t("products.editProduct")}</Button> : undefined}
      >
        <button
          onClick={() => setZoomed(true)}
          className="w-full aspect-square bg-canvas rounded-card overflow-hidden mb-4 cursor-zoom-in"
          aria-label={t("products.zoomImage")}
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
          <Label>{t("products.sku")}</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">{product.sku}</div>
          <Label>{t("products.description")}</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">{product.name}</div>
          <Label>{t("products.category")}</Label>
          <div className="px-3.5 py-2.5 rounded-card border border-hairline bg-canvas text-subhead">
            {product.category ?? t("common.notSet")}
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-hairline">
          <div className="text-headline font-bold mb-2">{t("products.details")}</div>
          <div className="grid grid-cols-2 gap-3">
            <ReadOnlyField label={t("products.priceAed")} value={formatAed(product.price)} />
            {isManager && <ReadOnlyField label={t("products.costAed")} value={product.cost != null ? formatAed(product.cost) : t("common.notSet")} />}
          </div>
          {isManager && product.cost != null && (
            <>
              <Label>{t("products.grossProfit")}</Label>
              <div className="flex items-center justify-between px-3.5 py-2.5 rounded-card border border-hairline bg-canvas">
                <span className="text-subhead tabular-nums">{(product.price - product.cost).toFixed(2)}</span>
                <span className="text-subhead text-secondary tabular-nums">
                  {product.price > 0 ? Math.round(((product.price - product.cost) / product.price) * 100) : 0}%
                </span>
              </div>
            </>
          )}
          <div className="grid grid-cols-2 gap-3">
            <ReadOnlyField label={t("products.defaultQuantity")} value={String(product.default_qty ?? t("common.notSet"))} />
            <ReadOnlyField
              label={t("products.stockOnHand")}
              value={product.stock_on_hand != null ? String(product.stock_on_hand) : t("common.notSet")}
            />
            <ReadOnlyField label={t("products.rack")} value={product.rack_location ?? t("common.notSet")} />
            <ReadOnlyField label={t("products.barcode")} value={product.barcode ?? t("common.notSet")} />
          </div>
          {sharedWith.length > 0 && (
            <p className="text-caption text-secondary mt-2">
              {t("products.stockSharedWith", { names: sharedWith.join(", ") })}
            </p>
          )}
          {isManager && lastSold !== undefined && (
            <p className="text-caption text-secondary mt-2">
              {lastSold
                ? lastSold.customerName
                  ? t("products.lastSoldToCustomer", {
                      price: formatAed(lastSold.price),
                      customer: lastSold.customerName,
                      date: new Date(lastSold.date).toLocaleDateString(),
                    })
                  : t("products.lastSold", {
                      price: formatAed(lastSold.price),
                      date: new Date(lastSold.date).toLocaleDateString(),
                    })
                : t("products.notSoldYet")}
            </p>
          )}
        </div>

        {isManager && (
          <div className="mt-5 pt-4 border-t border-hairline">
            <div className="text-headline font-bold mb-1">{t("products.additionalDetails")}</div>
            <p className="text-caption text-secondary mb-2">
              {t("products.additionalDetailsReadHint")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              {(() => {
                const f = resolveProductFigures(product, insight ?? undefined);
                const mark = (on: boolean) => (on ? t("products.enteredSuffix") : "");
                return (
                  <>
                    <ReadOnlyField
                      label={`${t("products.vac")}${mark(f.overridden.vac)}`}
                      value={f.vac != null ? formatAed(f.vac) : t("common.notSet")}
                    />
                    <ReadOnlyField
                      label={`${t("products.vacChinaParen")}${mark(f.overridden.vacChina)}`}
                      value={f.vacChina != null ? `¥${f.vacChina.toFixed(2)}` : t("common.notSet")}
                    />
                    <ReadOnlyField
                      label={`${t("products.stockArrivalDays")}${mark(f.overridden.sad)}`}
                      value={f.sad != null ? String(f.sad) : t("common.notSet")}
                    />
                    <ReadOnlyField
                      label={`${t("products.stockHoldingDays")}${mark(f.overridden.shd)}`}
                      value={f.shd != null ? f.shd.toFixed(0) : t("common.notSet")}
                    />
                  </>
                );
              })()}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 mt-5 text-subhead">
          <span className={product.is_active ? "text-accent font-semibold" : "text-secondary"}>
            {product.is_active ? t("products.active") : t("products.inactive")}
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
