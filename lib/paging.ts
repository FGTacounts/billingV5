// Reading a whole table, a page at a time.
//
// PostgREST answers one request with at most 1,000 rows (Supabase's "Max
// rows", checked against the live project on 2026-09-19: `products` holds
// 1,604 and a request for 5,000 came back with exactly 1,000). It does not
// say so — no error, no flag, the rest are simply not there. For a list on a
// screen that is a short list; for a balance it is money missing from a
// figure that still looks right.
//
// So every read of a table that grows with trade — orders, order_items,
// payment_orders, payments, grv_returns, grv_items — goes through here: ask
// for rows 0–999, then 1,000–1,999, and stop at the first page that comes
// back short. The caller's query MUST carry a stable, unique ordering
// (`.order("id")`, or both halves of a composite key), or the database is free
// to hand back the same row on two pages and leave another out.
//
// If "Max rows" is ever LOWERED below 1,000 in the Supabase API settings,
// every page would come back "short" and reads would stop early again:
// PAGE_SIZE has to come down with it.
//
// No imports, on purpose: `npm run test:paging` loads this file directly.
// The iPhone app does the same in Paging.swift. Change one, change both.

export const PAGE_SIZE = 1000;

/** How many ids go into one `in (...)` filter — they travel in the URL. */
export const ID_CHUNK = 200;

export interface Page<T> {
  data: T[] | null;
  error: unknown;
}

export interface PagingOptions<T> {
  pageSize?: number;
  /**
   * What makes a row the same row. Rows are paged by position, so an insert
   * landing between two requests pushes the last row of one page onto the
   * start of the next. Given a key, the second sighting is dropped — without
   * it a payment allocation read twice would be counted twice.
   */
  keyOf?: (row: T) => string;
}

/**
 * Every row of a query, in the query's own order. `fetchPage` is called with
 * inclusive bounds, the way `.range(from, to)` takes them, and must build a
 * fresh query each time. Throws whatever error a page reports.
 */
export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<Page<T>>,
  options: PagingOptions<T> = {}
): Promise<T[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error("fetchAllPages: pageSize must be a positive integer");
  const seen = options.keyOf ? new Set<string>() : null;
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw error;
    const page = data ?? [];
    for (const row of page) {
      if (seen) {
        const key = options.keyOf!(row);
        if (seen.has(key)) continue;
        seen.add(key);
      }
      rows.push(row);
    }
    if (page.length < pageSize) return rows;
  }
}

/**
 * The same, for a query filtered by a list of ids. The list is cut into
 * chunks short enough for a URL, and each chunk is paged in full — two
 * hundred orders can have more than a thousand lines between them.
 */
export async function fetchAllForIds<T>(
  ids: readonly string[],
  fetchPage: (chunk: string[], from: number, to: number) => PromiseLike<Page<T>>,
  options: PagingOptions<T> & { chunkSize?: number } = {}
): Promise<T[]> {
  const chunkSize = options.chunkSize ?? ID_CHUNK;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error("fetchAllForIds: chunkSize must be a positive integer");
  const unique = [...new Set(ids)];
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    // Not `push(...page)`: a spread of a hundred thousand rows overflows the stack.
    for (const row of await fetchAllPages((from, to) => fetchPage(chunk, from, to), options)) rows.push(row);
  }
  return rows;
}
