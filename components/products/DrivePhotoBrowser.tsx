"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Folder, ImageOff, Images, Search } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchProducts } from "@/lib/queries/products";
import type { Product } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import { t } from "@/lib/i18n";
import { EmptyState, Skeleton } from "@/components/ui/Empty";

/**
 * The Drive product-photo library, browsed as a folder tree — the web half of
 * the phone's PhotoBrowserView.
 *
 * The Gallery view groups catalogue rows into category folders and asks Drive
 * for a photo per SKU. This is the other way round: it walks the folders that
 * actually exist in Drive, the way the phone does, and resolves each photo
 * back to a catalogue row by its file name (the file name without its
 * extension is the SKU). Picked photos are handed to the same NewOrderSheet
 * the Gallery's multi-select uses.
 *
 * The browser holds no Google credential: every call here goes to
 * /api/drive/{root,list,search}, which authenticate the staff member and do
 * the Drive call server-side.
 */

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string | null;
  thumbnailLink?: string | null;
  webViewLink?: string | null;
}

interface Crumb {
  id: string;
  name: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const isFolder = (f: DriveItem) => f.mimeType === FOLDER_MIME;
const isImage = (f: DriveItem) => typeof f.mimeType === "string" && f.mimeType.startsWith("image/");

/** File name without its extension = the SKU, same rule the phone uses. */
function skuOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).trim();
}

/**
 * Drive's thumbnailLink, resized. Never the original file: these are 1000x1000
 * product shots and a folder of 200 of them would be tens of megabytes in a
 * grid. 512px is what the phone asks for, so both clients hit the same cached
 * thumbnail.
 */
function thumbUrl(link: string): string {
  return /=s\d+/.test(link) ? link.replace(/=s\d+/, "=s512") : `${link}=s512`;
}

interface Listing {
  files: DriveItem[];
  nextPageToken: string | null;
}

// Listings already fetched this session, so stepping back up the breadcrumbs
// is instant instead of a fresh Drive round trip, and so a folder that fails
// to reload (a dropped connection) can still be shown from the last copy —
// the same "keep browsing what you already loaded" behaviour the phone gets
// from its on-disk listing cache.
const listingCache = new Map<string, Listing>();

export default function DrivePhotoBrowser({
  onStartOrder,
}: {
  /** Hands the picked rows to the order sheet — the Gallery's own path. */
  onStartOrder: (products: Product[]) => void;
}) {
  const [root, setRoot] = useState<Crumb | null>(null);
  const [path, setPath] = useState<Crumb[]>([]);
  const [files, setFiles] = useState<DriveItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<DriveItem[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Keyed by SKU rather than by Drive file id, so a photo picked in one
  // folder stays picked after navigating away or searching.
  const [picked, setPicked] = useState<Record<string, Product>>({});

  // The catalogue, indexed by SKU. Loaded here rather than taken from the
  // Products list, because that list is narrowed by the page's search box and
  // this view browses Drive independently of it.
  const [bySku, setBySku] = useState<Map<string, Product> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProducts(supabaseBrowser(), {})
      .then((rows) => {
        if (cancelled) return;
        const map = new Map<string, Product>();
        for (const p of rows) {
          const key = p.sku.trim().toUpperCase();
          if (!map.has(key)) map.set(key, p);
        }
        setBySku(map);
      })
      .catch(() => {
        if (!cancelled) setBySku(new Map());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = path[path.length - 1] ?? root;

  // Only the newest folder response is allowed to land: clicking through
  // folders quickly otherwise leaves you looking at whichever request
  // happened to finish last. Search counts separately — a search must not
  // discard the folder load underneath it, or clearing the search would
  // leave an empty grid behind.
  const folderSeq = useRef(0);
  const searchSeq = useRef(0);

  const openFolder = useCallback(async (folderId: string) => {
    const seq = ++folderSeq.current;
    const cached = listingCache.get(folderId);
    if (cached) {
      setFiles(cached.files);
      setNextPageToken(cached.nextPageToken);
      setLoading(false);
    } else {
      setFiles([]);
      setNextPageToken(null);
      setLoading(true);
    }
    setError(null);
    setStale(false);

    try {
      const res = await fetch(`/api/drive/list?folderId=${encodeURIComponent(folderId)}`);
      const data = await res.json();
      if (seq !== folderSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? t("products.folderOpenFailed"));
      const listing: Listing = {
        files: (data.files ?? []) as DriveItem[],
        nextPageToken: data.nextPageToken ?? null,
      };
      listingCache.set(folderId, listing);
      setFiles(listing.files);
      setNextPageToken(listing.nextPageToken);
    } catch (err) {
      if (seq !== folderSeq.current) return;
      // A folder already loaded once stays readable; only a folder with
      // nothing cached has to show the failure.
      if (cached) setStale(true);
      else setError(err instanceof Error ? err.message : t("products.folderOpenFailed"));
    } finally {
      if (seq === folderSeq.current) setLoading(false);
    }
  }, []);

  // Find the top of the library, then open it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/drive/root");
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(data.error ?? t("products.photosNotConfigured"));
        setRoot({ id: data.folderId as string, name: (data.name as string) || "Products" });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : t("products.photosNotConfigured"));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    void openFolder(current.id);
  }, [current, openFolder]);

  async function loadMore() {
    if (!current || !nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `/api/drive/list?folderId=${encodeURIComponent(current.id)}&pageToken=${encodeURIComponent(nextPageToken)}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("products.loadMoreFailed"));
      const more = (data.files ?? []) as DriveItem[];
      const token = (data.nextPageToken ?? null) as string | null;
      setFiles((prev) => {
        const merged = [...prev, ...more];
        listingCache.set(current.id, { files: merged, nextPageToken: token });
        return merged;
      });
      setNextPageToken(token);
    } catch {
      setStale(true);
    } finally {
      setLoadingMore(false);
    }
  }

  // Search runs over the whole library the service account can see, so it
  // reaches photos in folders you have not opened — the same as on the phone,
  // where it also lists photos only.
  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/drive/search?q=${encodeURIComponent(text)}`);
        const data = await res.json();
        if (seq !== searchSeq.current) return;
        if (!res.ok) throw new Error(data.error ?? t("products.searchFailed"));
        setResults(((data.files ?? []) as DriveItem[]).filter(isImage));
      } catch {
        if (seq === searchSeq.current) setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const showingSearch = results !== null;
  const source = showingSearch ? results : files;
  const folders = useMemo(() => (showingSearch ? [] : source.filter(isFolder)), [source, showingSearch]);
  const photos = useMemo(() => source.filter(isImage), [source]);

  function productFor(file: DriveItem): Product | undefined {
    return bySku?.get(skuOf(file.name).toUpperCase());
  }

  function togglePick(file: DriveItem) {
    const product = productFor(file);
    if (!product) return;
    const key = product.sku.trim().toUpperCase();
    setPicked((prev) => {
      if (prev[key]) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: product };
    });
  }

  function enterFolder(file: DriveItem) {
    setQuery("");
    setResults(null);
    setPath((prev) => [...prev, { id: file.id, name: file.name }]);
  }

  function goTo(index: number) {
    // -1 is the root crumb.
    setQuery("");
    setResults(null);
    setPath((prev) => prev.slice(0, index + 1));
  }

  const pickedList = Object.values(picked);
  const busy = loading || (searching && results === null);

  if (error && files.length === 0) {
    return (
      <EmptyState
        icon={ImageOff}
        title={
          error.includes("product_photos_drive_folder_id")
            ? t("products.photoFolderNotSet")
            : error
        }
      />
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <button
          onClick={() => goTo(path.length - 2)}
          disabled={path.length === 0}
          className="min-w-11 min-h-11 px-2 grid place-items-center rounded-card text-secondary hover:text-primary hover:bg-primary/[0.04] disabled:opacity-30 disabled:pointer-events-none transition-colors"
          aria-label={t("products.backToParentFolder")}
        >
          <ChevronLeft size={18} />
        </button>

        {/* Breadcrumbs. Horizontally scrollable rather than wrapping, so a
            deep path never pushes the grid down the page. */}
        <nav aria-label={t("products.folderPath")} className="flex items-center gap-1 overflow-x-auto min-w-0 flex-1">
          <button
            onClick={() => goTo(-1)}
            className={`min-h-11 px-2.5 rounded-chip text-caption font-semibold whitespace-nowrap transition-colors ${
              path.length === 0 ? "text-primary" : "text-secondary hover:text-accent"
            }`}
          >
            {root?.name ?? "Products"}
          </button>
          {path.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1 whitespace-nowrap">
              <span aria-hidden className="text-secondary">
                /
              </span>
              <button
                onClick={() => goTo(i)}
                className={`min-h-11 px-2.5 rounded-chip text-caption font-semibold transition-colors ${
                  i === path.length - 1 ? "text-primary" : "text-secondary hover:text-accent"
                }`}
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        <div className="relative min-w-[200px]">
          <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-secondary" />
          <input
            className="w-full ps-9 pe-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent"
            placeholder={t("products.searchPhotos")}
            aria-label={t("products.searchPhotosLabel")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      {stale && (
        <div className="text-caption text-secondary mb-3">
          {t("products.driveUnreachableStale")}
        </div>
      )}

      {busy ? (
        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <Skeleton className="w-full aspect-square" style={{ animationDelay: `${i * 90}ms` }} />
              <Skeleton className="h-3 w-2/3" style={{ animationDelay: `${i * 90}ms` }} />
            </div>
          ))}
        </div>
      ) : folders.length === 0 && photos.length === 0 ? (
        <EmptyState
          icon={Images}
          title={showingSearch ? t("products.noPhotosMatch") : t("products.folderEmpty")}
        />
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={() => enterFolder(f)}
                className="flex flex-col items-center gap-1.5 group"
              >
                <div className="w-full aspect-square rounded-card bg-canvas border border-hairline grid place-items-center text-secondary group-hover:border-accent/50 group-hover:text-accent transition-colors">
                  <Folder size={40} strokeWidth={1.5} />
                </div>
                <span className="text-caption font-semibold text-center leading-tight line-clamp-2">
                  {f.name}
                </span>
              </button>
            ))}

            {photos.map((f) => {
              const product = productFor(f);
              const sku = skuOf(f.name);
              const isPicked = product ? Boolean(picked[product.sku.trim().toUpperCase()]) : false;
              return (
                <PhotoTile
                  key={f.id}
                  file={f}
                  sku={sku}
                  product={product}
                  picked={isPicked}
                  // The catalogue index has not arrived yet — leave tiles
                  // inert for that moment rather than telling someone a real
                  // SKU is missing from the catalogue.
                  resolving={bySku === null}
                  onToggle={() => togglePick(f)}
                />
              );
            })}
          </div>

          {!showingSearch && nextPageToken && (
            <div className="flex justify-center mt-4">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="min-h-11 px-4 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-primary disabled:opacity-50 transition-colors"
              >
                {loadingMore ? t("common.loading") : t("products.showMore")}
              </button>
            </div>
          )}
        </>
      )}

      {/* Same bar, same place, as picking rows in the List view. */}
      {pickedList.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 p-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pointer-events-none">
          <div className="max-w-[1600px] mx-auto flex justify-center">
            <div className="pointer-events-auto flex items-center gap-4 px-4 py-3 rounded-full shadow-overlay bg-surface border border-hairline">
              <span className="text-subhead font-semibold tabular-nums">
                {t("products.nSelected", { n: pickedList.length })}
              </span>
              <button
                onClick={() => setPicked({})}
                className="min-h-11 text-caption text-secondary hover:text-primary"
              >
                {t("products.clear")}
              </button>
              <button
                onClick={() => onStartOrder(pickedList)}
                className="min-h-11 px-4 rounded-full bg-accent text-white text-caption font-semibold"
              >
                {t("products.startOrder")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PhotoTile({
  file,
  sku,
  product,
  picked,
  resolving,
  onToggle,
}: {
  file: DriveItem;
  sku: string;
  product?: Product;
  picked: boolean;
  resolving: boolean;
  onToggle: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const selectable = Boolean(product);

  return (
    <button
      onClick={onToggle}
      disabled={!selectable}
      aria-pressed={picked}
      aria-label={
        product
          ? t("products.photoLabel", { sku, name: product.name })
          : t("products.photoLabelNotInCatalogue", { sku })
      }
      title={product ? product.name : t("products.notInCatalogue")}
      className={`flex flex-col items-center gap-1.5 group text-center ${
        selectable ? "" : "opacity-60 cursor-default"
      }`}
    >
      <div
        className={`relative w-full aspect-square rounded-card overflow-hidden bg-canvas border transition-colors ${
          picked ? "border-accent" : "border-hairline group-hover:border-accent/50"
        }`}
      >
        {file.thumbnailLink && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbUrl(file.thumbnailLink)}
            alt={sku}
            loading="lazy"
            onError={() => setBroken(true)}
            className={`w-full h-full object-cover transition-opacity ${picked ? "opacity-55" : ""}`}
          />
        ) : (
          // No thumbnail from Drive: the SKU, never the full-resolution file.
          <span className="w-full h-full grid place-items-center px-2 text-caption text-secondary break-all">
            {sku}
          </span>
        )}
        {picked && (
          <span
            aria-hidden
            className="absolute top-2 end-2 w-6 h-6 rounded-full bg-accent text-white grid place-items-center text-caption font-semibold"
          >
            ✓
          </span>
        )}
      </div>
      <span className="text-caption font-semibold leading-tight line-clamp-2">{sku}</span>
      {product ? (
        <span className="text-caption text-secondary tabular-nums -mt-1">{formatAed(product.price)}</span>
      ) : (
        !resolving && <span className="text-caption text-secondary -mt-1">{t("products.notInCatalogueShort")}</span>
      )}
    </button>
  );
}
