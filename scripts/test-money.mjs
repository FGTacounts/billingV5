#!/usr/bin/env node
/**
 * Famlist Billing — money arithmetic check.
 *
 *   npm run test:money
 *
 * WHY THIS EXISTS
 *
 * CLAUDE.md rule 6 says money is never a float. The database already obeys
 * it: every money column is Postgres `numeric`, which is exact decimal. The
 * application did not. Totals were computed in JavaScript, which has only
 * floats, and written to those exact columns WITHOUT ROUNDING — so an order
 * could be stored, billed and VAT-returned as 1234.5600000000002.
 *
 * lib/money.ts now counts in fils and rounds once. This proves it, and
 * proves the two things a customer checking an invoice by hand cares about:
 *
 *   1. No stored figure carries more than two decimal places.
 *   2. The lines plus the VAT equal the total exactly.
 *
 * The iPhone app does the same arithmetic in the same order (Money.swift).
 * If you change one, change both and re-run this.
 */

const m = await import("../lib/money.ts");

const RATE = 0.05;
let failures = 0;

function check(label, condition, detail = "") {
  if (!condition) failures++;
  console.log(`  ${condition ? "OK  " : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

/** A figure safe to store: at most two decimal places when written out. */
function isCleanMoney(n) {
  return Number.isFinite(n) && !/\.\d{3,}/.test(String(n));
}

function line(price, qty) {
  return { unit_price: price, ordered_qty: qty, picked_qty: null };
}

console.log("Money arithmetic — figures that reach the database\n");

// The cases that used to produce an artefact, plus orders big enough that a
// per-line error would accumulate into real money.
const cases = [
  ["a tenth plus a fifth", [line(0.1, 1), line(0.2, 1)]],
  ["a third of a fil", [line(12.345, 3)]],
  ["a price ending in 5", [line(0.005, 1), line(0.015, 1)]],
  ["37 lines of 19.99", Array.from({ length: 37 }, () => line(19.99, 7))],
  ["120 lines, rising price", Array.from({ length: 120 }, (_, i) => line(1.05 + i * 0.01, 13))],
  ["one very large line", [line(99999.99, 999)]],
  ["an empty order", []],
];

for (const [label, items] of cases) {
  const sub = m.subtotal(items);
  const tax = m.vat(items, RATE);
  const tot = m.total(items, RATE);
  const clean = isCleanMoney(sub) && isCleanMoney(tax) && isCleanMoney(tot);
  const addsUp = Math.abs(sub + tax - tot) < 1e-9;
  check(
    label.padEnd(26),
    clean && addsUp,
    `sub ${sub}  vat ${tax}  total ${tot}`
  );
}

console.log("");

// Each printed line must be a storable figure too, and they must sum to the
// printed subtotal — otherwise an invoice does not add up on paper.
const mixed = [line(3.33, 3), line(0.07, 17), line(19.995, 2), line(1.01, 99)];
const printedLines = mixed.map((it) => m.lineTotal(it));
check("every line is storable", printedLines.every(isCleanMoney), printedLines.join(", "));
check(
  "lines sum to the subtotal",
  Math.abs(printedLines.reduce((a, b) => a + b, 0) - m.subtotal(mixed)) < 1e-9
);

// The approval path uses billed() with a subtotal it already holds; it must
// agree with computing from the lines.
const fromLines = { sub: m.subtotal(mixed), vat: m.vat(mixed, RATE), total: m.total(mixed, RATE) };
const fromBilled = m.billed(fromLines.sub, RATE);
check(
  "approval agrees with the lines",
  fromBilled.subtotal === fromLines.sub &&
    fromBilled.vatAmount === fromLines.vat &&
    fromBilled.total === fromLines.total,
  `${fromBilled.total} vs ${fromLines.total}`
);

// Discounts are money too.
check("percent discount is storable", isCleanMoney(m.applyDiscount(19.99, { discount_type: "percent", discount_value: 7.5 })));
check("amount discount is storable", isCleanMoney(m.applyDiscount(19.99, { discount_type: "amount", discount_value: 0.07 })));
check("a discount never goes below zero", m.applyDiscount(5, { discount_type: "amount", discount_value: 500 }) === 0);

// ── The customer's old price ────────────────────────────────────────────
// What a product costs THIS customer when it goes on an order. One rule for a
// new order, a line added later, and an imported line.
console.log("\nThe customer's old price");
{
  const pct10 = { discount_type: "percent", discount_value: 10 };
  const off2 = { discount_type: "amount", discount_value: 2 };
  const r = (input) => m.resolveLinePrice(input);

  check("no history, no discount: the list price", r({ listPrice: 25 }).price === 25 && r({ listPrice: 25 }).reason === null);
  check("the price last billed beats the list price",
    r({ listPrice: 25, stickyPrice: 21.5 }).price === 21.5 && r({ listPrice: 25, stickyPrice: 21.5 }).reason === "sticky_price");
  check("the old price holds even after the list price goes UP", r({ listPrice: 30, stickyPrice: 21.5 }).price === 21.5);
  check("the old price holds even after the list price goes DOWN", r({ listPrice: 18, stickyPrice: 21.5 }).price === 21.5);
  // 2026-09-21: nothing is discounted unless a manager does it. A remembered
  // customer discount handed to the rule must change nothing.
  check("a remembered customer discount is NOT applied — percent",
    r({ listPrice: 25, customerDiscount: pct10 }).price === 25 && r({ listPrice: 25, customerDiscount: pct10 }).reason === null);
  check("a remembered customer discount is NOT applied — amount", r({ listPrice: 25, customerDiscount: off2 }).price === 25);
  check("the old price still applies beside a remembered discount",
    r({ listPrice: 25, stickyPrice: 24, customerDiscount: pct10 }).price === 24);
  check("a price written on the scanned or imported document beats everything",
    r({ listPrice: 25, stickyPrice: 21.5, customerDiscount: pct10, statedPrice: 19 }).price === 19 &&
      r({ listPrice: 25, stickyPrice: 21.5, statedPrice: 19 }).reason === "stated");
  check("a blank price on the document falls back to the old price",
    r({ listPrice: 25, stickyPrice: 21.5, statedPrice: null }).price === 21.5 &&
      r({ listPrice: 25, stickyPrice: 21.5, statedPrice: 0 }).price === 21.5);
  check("an old price of zero is not a price — the next order is not billed at nothing",
    r({ listPrice: 25, stickyPrice: 0 }).price === 25 && r({ listPrice: 25, stickyPrice: 0, customerDiscount: pct10 }).price === 25);
  check("a broken old price is ignored", r({ listPrice: 25, stickyPrice: NaN }).price === 25 && r({ listPrice: 25, stickyPrice: -4 }).price === 25);
  check("every resolved price is storable",
    [r({ listPrice: 19.999 }), r({ listPrice: 10, stickyPrice: 21.499999999 })]
      .every((x) => isCleanMoney(x.price)));
}

// ── A manager's per-product discount ────────────────────────────────────
console.log("\nPer-product discount on an order line");
{
  check("10% off 25.00 charges 22.50", m.lineDiscountPrice(25, 10) === 22.5);
  check("the discount reads back as what was typed", m.lineDiscountPercent(25, m.lineDiscountPrice(25, 10)) === 10);
  check("half-percent steps survive the round trip", m.lineDiscountPercent(200, m.lineDiscountPrice(200, 12.5)) === 12.5);
  check("no discount charges the list price", m.lineDiscountPrice(25, 0) === 25 && m.lineDiscountPercent(25, 25) === 0);
  check("100% is free, and never below zero", m.lineDiscountPrice(25, 100) === 0 && m.lineDiscountPrice(25, 250) === 0);
  check("a negative discount is not a surcharge", m.lineDiscountPrice(25, -10) === 25);
  check("a price above list is not shown as a discount", m.lineDiscountPercent(25, 30) === 0);
  check("a product with no list price shows no discount", m.lineDiscountPercent(0, 10) === 0);
  check("the discounted price is storable", isCleanMoney(m.lineDiscountPrice(19.99, 7.5)));
}

// ── Collecting a payment ────────────────────────────────────────────────
// Cash AND discount come off the ticked invoices, oldest first, then the
// customer's other invoices. Payments.allocate in the iPhone app must give
// the same slices for the same input.
console.log("\nCollecting a payment");
const inv = (orderId, invoiceDate, balance) => ({ orderId, invoiceDate, balance });
const A = inv("A", "2026-01-10", 300);
const B = inv("B", "2026-02-10", 500);
const C = inv("C", "2026-03-10", 400);
const sum = (slices) => m.toAed(slices.reduce((s, x) => s + m.toFils(x.amount), 0));

{
  // 700 cash + 100 discount against B and C: B is older, so B fills first.
  const slices = m.allocateFifo(m.settledNow(700, 100), [C, B], [A]);
  check("the discount is settled together with the cash", m.settledNow(700, 100) === 800);
  check("ticked invoices are paid oldest first", slices[0].orderId === "B" && slices[0].amount === 500);
  check("the rest goes to the next ticked invoice", slices[1].orderId === "C" && slices[1].amount === 300);
  check("an unticked invoice is left alone while ticked ones have room", !slices.some((s) => s.orderId === "A"));
  check("slices add up to cash + discount", sum(slices) === 800, `${sum(slices)}`);
}
{
  // Paying more than the ticked invoices owe spills into the oldest other one.
  const slices = m.allocateFifo(m.settledNow(600, 0), [B], [C, A]);
  check("extra money cascades to the customer's oldest other invoice",
    slices.length === 2 && slices[1].orderId === "A" && slices[1].amount === 100);
}
{
  // Nothing ticked = everything outstanding, oldest first.
  const slices = m.allocateFifo(450, [], [C, B, A]);
  check("nothing ticked means oldest first across everything",
    slices.map((s) => s.orderId).join("") === "AB" && slices[1].amount === 150);
}
{
  // More than the customer owes: the excess stays unallocated, never invented.
  const slices = m.allocateFifo(5000, [A], [B, C]);
  check("no invoice is given more than it owes", sum(slices) === 1200 && slices.every((s) => s.amount > 0));
}
{
  const thirds = [inv("X", "2026-01-01", 33.33), inv("Y", "2026-01-02", 33.33), inv("Z", "2026-01-03", 33.34)];
  const slices = m.allocateFifo(m.settledNow(90.01, 9.99), thirds, []);
  check("fils survive the split", sum(slices) === 100 && slices.every((s) => isCleanMoney(s.amount)));
  check("a discount alone still settles debt", sum(m.allocateFifo(m.settledNow(0, 50), [A], [])) === 50);
  check("a negative figure settles nothing", m.settledNow(-20, -5) === 0);
}

// Conversions round-trip.
check(
  "AED survives a round trip through fils",
  [0.01, 0.05, 12.34, 999.99, 100000].every((v) => m.toAed(m.toFils(v)) === v)
);

console.log(
  failures === 0
    ? "\nPASS — nothing with more than two decimals can reach the database.\n"
    : `\nFAIL — ${failures} problem(s). A figure here becomes a real invoice.\n`
);
process.exit(failures === 0 ? 0 : 1);
