"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

export const PAGE_SIZE_OPTIONS = [50, 100, 200] as const;
export const SHOW_ALL = 0;

/**
 * Client-side paging for lists that are already fully in memory.
 *
 * The catalogue renders 1,300+ rows otherwise, which is what made scrolling
 * stick: every row is a live React node, and on Products each one also fires
 * a photo request. Fifty rows is enough to work with and cheap to render.
 *
 * Paging state resets whenever the filtered set changes — otherwise
 * searching while on page 12 leaves you staring at an empty screen.
 */
export function usePagination<T>(items: T[], defaultSize: number = 50) {
  const [pageSize, setPageSize] = useState<number>(defaultSize);
  const [page, setPage] = useState(1);

  const total = items.length;
  const pageCount = pageSize === SHOW_ALL ? 1 : Math.max(1, Math.ceil(total / pageSize));

  // Go back to page 1 whenever the underlying list changes — a search, a
  // filter, a re-sort. Without this, searching from page 2 left you looking
  // at results 51 onward, or at nothing at all when the new set was smaller.
  //
  // Keyed on the array identity rather than its length: both call sites build
  // this list with useMemo, so the reference changes exactly when the filters
  // that produced it changed, and not on every render.
  const lastItems = useRef(items);
  useEffect(() => {
    if (lastItems.current !== items) {
      lastItems.current = items;
      setPage(1);
    }
  }, [items]);

  // And snap back into range if the list shrinks for any other reason.
  useEffect(() => {
    if (page > pageCount) setPage(1);
  }, [page, pageCount]);

  const visible = useMemo(() => {
    if (pageSize === SHOW_ALL) return items;
    const start = (page - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, page, pageSize]);

  return {
    visible,
    page,
    setPage,
    pageSize,
    setPageSize: (n: number) => {
      setPageSize(n);
      setPage(1);
    },
    pageCount,
    total,
    from: total === 0 ? 0 : (page - 1) * (pageSize || total) + 1,
    to: pageSize === SHOW_ALL ? total : Math.min(total, page * pageSize),
  };
}

export function Pagination({
  page,
  setPage,
  pageCount,
  pageSize,
  setPageSize,
  total,
  from,
  to,
  noun = "items",
}: {
  page: number;
  setPage: (n: number) => void;
  pageCount: number;
  pageSize: number;
  setPageSize: (n: number) => void;
  total: number;
  from: number;
  to: number;
  noun?: string;
}) {
  if (total === 0) return null;
  const showingAll = pageSize === SHOW_ALL;

  function go(next: number) {
    setPage(next);
    // Jump back to the top of the list, otherwise page 2 opens scrolled to
    // the bottom of page 1.
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mt-4">
      <span className="text-caption text-secondary tabular-nums">
        {showingAll ? `All ${total} ${noun}` : `${from}–${to} of ${total} ${noun}`}
      </span>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-caption text-secondary">
          Show
          <select
            value={pageSize}
            onChange={(e) => setPageSize(Number(e.target.value))}
            className="rounded-chip border border-hairline bg-surface px-2.5 py-1 text-caption font-semibold tabular-nums"
            aria-label={`${noun} per page`}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
            <option value={SHOW_ALL}>All</option>
          </select>
        </label>

        {!showingAll && pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => go(page - 1)}
              disabled={page <= 1}
              className="w-8 h-8 grid place-items-center rounded-full border border-hairline text-secondary hover:text-accent hover:border-accent/50 disabled:opacity-35 disabled:pointer-events-none"
              aria-label="Previous page"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-caption tabular-nums px-1 min-w-[64px] text-center">
              {page} / {pageCount}
            </span>
            <button
              onClick={() => go(page + 1)}
              disabled={page >= pageCount}
              className="w-8 h-8 grid place-items-center rounded-full border border-hairline text-secondary hover:text-accent hover:border-accent/50 disabled:opacity-35 disabled:pointer-events-none"
              aria-label="Next page"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
