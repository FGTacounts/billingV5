#!/usr/bin/env node
/**
 * Famlist Billing — reading a table past PostgREST's row ceiling.
 *
 *   npm run test:paging
 *
 * WHY THIS EXISTS
 *
 * PostgREST answers one request with at most 1,000 rows and does not say
 * when it has cut the answer short. Aging read `orders` in one request, so
 * past 1,000 billed orders invoices would have dropped out of every balance,
 * statement, aging report, planning rank and salesman statement — silently,
 * with every figure still looking like a figure (docs/DECISIONS.md,
 * 2026-09-18 "RISK, not fixed", and 2026-09-19).
 *
 * lib/paging.ts now reads such tables a page at a time. This proves it
 * against a stand-in for the database that behaves the way the real one does:
 * it never returns more than 1,000 rows, whatever it is asked for.
 *
 * It touches no network and no database. The iPhone app has the same helper
 * (Paging.swift) and the same test (PagingTests.swift). Change one, change
 * both and re-run this.
 */

const { fetchAllPages, fetchAllForIds, PAGE_SIZE, ID_CHUNK } = await import("../lib/paging.ts");

let failures = 0;
function check(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "OK  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

const SERVER_CAP = 1000;

/** `count` rows with ids that sort the way they were made: row-00000, row-00001 … */
function makeRows(count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({ id: `row-${String(i).padStart(5, "0")}`, n: i, ...extra }));
}

/**
 * A table behind PostgREST: answers `.range(from, to)` from its rows in id
 * order, and never with more than SERVER_CAP of them.
 */
function fakeTable(rows) {
  const calls = [];
  const table = {
    rows,
    calls,
    page(from, to) {
      calls.push([from, to]);
      const sorted = [...table.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const end = Math.min(to + 1, from + SERVER_CAP);
      return Promise.resolve({ data: sorted.slice(from, end), error: null });
    },
  };
  return table;
}

const sameIds = (got, want) => got.length === want.length && got.every((r, i) => r.id === want[i].id);

console.log("Paging — nothing is lost past the 1,000-row ceiling\n");

// The defect, stated as a test: ask for everything at once, get a thousand.
{
  const table = fakeTable(makeRows(2500));
  const { data } = await table.page(0, 999_999);
  check("one unpaged request for 2,500 rows comes back with only 1,000", data.length === 1000, `(${data.length})`);
}

// The task's own case.
{
  const want = makeRows(2500);
  const table = fakeTable(want);
  const got = await fetchAllPages((from, to) => table.page(from, to));
  check("2,500 rows come back complete", got.length === 2500, `(${got.length})`);
  check("2,500 rows come back in order", sameIds(got, want));
  check("no row is repeated", new Set(got.map((r) => r.id)).size === 2500);
  check(
    "in three requests: 0–999, 1000–1999, 2000–2999",
    JSON.stringify(table.calls) === JSON.stringify([[0, 999], [1000, 1999], [2000, 2999]]),
    JSON.stringify(table.calls)
  );
}

// The edges of "stop at the first short page".
for (const [label, count, requests] of [
  ["an empty table", 0, 1],
  ["one row", 1, 1],
  ["999 rows — one short of a page", 999, 1],
  ["exactly 1,000 rows — a full page must be followed by another look", 1000, 2],
  ["1,001 rows", 1001, 2],
  ["exactly 2,000 rows", 2000, 3],
]) {
  const want = makeRows(count);
  const table = fakeTable(want);
  const got = await fetchAllPages((from, to) => table.page(from, to));
  check(`${label}: all ${count} back, ${requests} request${requests === 1 ? "" : "s"}`, sameIds(got, want) && table.calls.length === requests, `(${got.length} rows, ${table.calls.length} requests)`);
}

check("the page size is the ceiling itself", PAGE_SIZE === SERVER_CAP);

// A null page is an empty page, as supabase-js reports one.
{
  const got = await fetchAllPages(() => Promise.resolve({ data: null, error: null }));
  check("a null page reads as no rows", Array.isArray(got) && got.length === 0);
}

// A failed page fails the read. Half a ledger must never pass for a whole one.
{
  const table = fakeTable(makeRows(2500));
  let threw = null;
  let got = null;
  try {
    got = await fetchAllPages((from, to) =>
      from === 1000 ? Promise.resolve({ data: null, error: new Error("boom") }) : table.page(from, to)
    );
  } catch (e) {
    threw = e;
  }
  check("an error on the second page throws rather than returning the first", threw?.message === "boom" && got === null);
}

// A row inserted between two requests pushes the last row of page one onto
// the start of page two. With a key it is kept once; and the money adds up.
{
  const table = fakeTable(makeRows(1500, { amount: 10 }));
  const got = await fetchAllPages(
    (from, to) => {
      if (from === 1000) table.rows = [{ id: "row-00000-new", n: -1, amount: 10 }, ...table.rows];
      return table.page(from, to);
    },
    { keyOf: (r) => r.id }
  );
  const ids = got.map((r) => r.id);
  check("a row seen on two pages is kept once", new Set(ids).size === ids.length && ids.length === 1500, `(${ids.length} rows)`);
  check("so an allocation is not counted twice", got.reduce((s, r) => s + r.amount, 0) === 15000);
}

// Filtered by a list of ids: chunked for the URL, and every chunk paged.
{
  const ids = Array.from({ length: 450 }, (_, i) => `order-${String(i).padStart(4, "0")}`);
  // Six lines an order — 2,700 in all, and 1,200 for the first chunk alone.
  const lines = ids.flatMap((orderId, o) =>
    Array.from({ length: 6 }, (_, l) => ({ id: `line-${String(o).padStart(4, "0")}-${l}`, order_id: orderId }))
  );
  const chunksSeen = [];
  const got = await fetchAllForIds(ids, (chunk, from, to) => {
    if (from === 0) chunksSeen.push(chunk.length);
    return fakeTable(lines.filter((l) => chunk.includes(l.order_id))).page(from, to);
  });
  check("450 ids go out as 200 + 200 + 50", JSON.stringify(chunksSeen) === JSON.stringify([200, 200, 50]) && ID_CHUNK === 200, JSON.stringify(chunksSeen));
  check("all 2,700 lines come back, though each chunk holds more than a page", got.length === 2700 && new Set(got.map((l) => l.id)).size === 2700, `(${got.length})`);
  check("and in order", sameIds(got, lines));

  const none = await fetchAllForIds([], () => {
    throw new Error("must not be called");
  });
  check("no ids, no request", none.length === 0);

  let requests = 0;
  await fetchAllForIds(["a", "a", "b", "a"], (chunk, from, to) => {
    requests++;
    check("repeated ids are asked for once", JSON.stringify(chunk) === JSON.stringify(["a", "b"]));
    return fakeTable([]).page(from, to);
  });
  check("in one request", requests === 1);
}

// Nonsense in, error out — not an endless loop.
for (const bad of [0, -1, 1.5, NaN]) {
  let threw = false;
  try {
    await fetchAllPages(() => Promise.resolve({ data: [], error: null }), { pageSize: bad });
  } catch {
    threw = true;
  }
  check(`a page size of ${bad} is refused`, threw);
}

console.log(failures === 0 ? "\nAll paging checks passed." : `\n${failures} paging check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
