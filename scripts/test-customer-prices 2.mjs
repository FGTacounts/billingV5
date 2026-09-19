#!/usr/bin/env node
/**
 * Famlist Billing — the customer's old price, checked against the live book.
 *
 *   npm run test:prices
 *
 * WHY THIS EXISTS
 *
 * When a product goes on an order, this customer's last-billed price for it is
 * the price (lib/money.ts resolveLinePrice; NewOrderView on the phone). That
 * price is remembered in `customer_prices`, written when an order is approved
 * — by the web's approve route and by AppDataManager.saveCustomerPrices.
 *
 * `npm run test:money` proves the RULE. This proves the MEMORY: that what
 * customer_prices says a customer last paid is what their most recent billed
 * order actually charged them. If the two disagree, the next order for that
 * customer is quoted a price nobody agreed.
 *
 * READ-ONLY. It selects and compares; it writes nothing, ever. It reads with
 * the service key from .env.local because customer_prices is not readable
 * without signing in, and it prints names of products and customers only in
 * the rows it reports as wrong.
 *
 * Exit code 0 = every remembered price matches. 1 = something to look at.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(ROOT, ".env.local");
if (!existsSync(envFile)) {
  console.error("Could not find .env.local — this check needs the project's Supabase URL and service key.");
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim().replace(/^"|"$/g, "")])
);
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be in .env.local.");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

// An order has been billed once it is approved — that is the moment the price
// is remembered — and stays billed through delivery.
const BILLED = ["approved", "delivering", "delivered"];
const fils = (n) => Math.round(Number(n) * 100);

async function all(table, columns, shape = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await shape(db.from(table).select(columns)).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < 1000) return rows;
  }
}

let problems = 0;
const report = (ok, label, detail = "") => {
  if (!ok) problems++;
  console.log(`  ${ok ? "OK  " : "LOOK"}  ${label}${detail ? `  ${detail}` : ""}`);
};

console.log("\nThe customer's old price — live book\n");

const [orders, remembered] = await Promise.all([
  all("orders", "id, customer_id, status, updated_at, deleted_at", (q) => q.in("status", BILLED)),
  all("customer_prices", "customer_id, product_id, price, updated_at"),
]);
const billedOrders = orders.filter((o) => o.customer_id && !o.deleted_at);
const orderById = new Map(billedOrders.map((o) => [o.id, o]));

const items = [];
const ids = [...orderById.keys()];
for (let i = 0; i < ids.length; i += 150) {
  items.push(
    ...(await all("order_items", "order_id, product_id, sku, unit_price, ordered_qty, picked_qty", (q) =>
      q.in("order_id", ids.slice(i, i + 150))
    ))
  );
}

// The most recent billed line per customer + product.
const lastBilled = new Map();
for (const it of items) {
  const order = orderById.get(it.order_id);
  if (!order || !it.product_id) continue;
  const k = `${order.customer_id}|${it.product_id}`;
  const seen = lastBilled.get(k);
  if (!seen || new Date(order.updated_at) > new Date(seen.at)) {
    lastBilled.set(k, { at: order.updated_at, price: it.unit_price, sku: it.sku, customerId: order.customer_id });
  }
}
const rememberedByKey = new Map(remembered.map((r) => [`${r.customer_id}|${r.product_id}`, r]));

console.log(`  ${billedOrders.length} billed orders · ${items.length} billed lines · ${remembered.length} remembered prices\n`);

// A pass over nothing proves nothing, so say so. The order history was loaded
// into this database without its line items: the invoices and their totals
// are here, what was on them is not. Until orders are approved in the app (or
// the historical lines are imported), no customer HAS an old price, and every
// product is quoted at list price or the customer's standing discount.
if (items.length === 0) {
  console.log(
    "  note  None of the billed orders has any line items, so there is nothing to remember a\n" +
      "        price FROM. The checks below pass because they are comparing nothing. Old prices\n" +
      "        start working from the first order approved in the app; to have them for past\n" +
      "        invoices, the historical invoice LINES need importing (customer, article, price).\n"
  );
}

const missing = [];
const wrong = [];
for (const [k, last] of lastBilled) {
  const mem = rememberedByKey.get(k);
  if (!mem) missing.push({ k, last });
  else if (fils(mem.price) !== fils(last.price)) wrong.push({ k, last, mem });
}
const zero = remembered.filter((r) => !(Number(r.price) > 0));
const unclean = remembered.filter((r) => /\.\d{3,}/.test(String(r.price)));
const orphans = remembered.filter((r) => !lastBilled.has(`${r.customer_id}|${r.product_id}`));

report(wrong.length === 0, "every remembered price is what the customer was last billed", wrong.length ? `${wrong.length} differ` : "");
report(missing.length === 0, "every billed customer + product has a remembered price", missing.length ? `${missing.length} not remembered` : "");
report(zero.length === 0, "no remembered price is zero or negative", zero.length ? `${zero.length} rows` : "");
report(unclean.length === 0, "no remembered price carries more than two decimals", unclean.length ? `${unclean.length} rows` : "");
console.log(
  `  note  ${orphans.length} remembered price(s) have no billed line behind them` +
    (orphans.length ? " — set from an order since trashed, or one billed without its lines." : ".")
);

if (wrong.length || missing.length) {
  const customerIds = [...new Set([...wrong, ...missing].map((x) => x.last.customerId))].slice(0, 200);
  const { data: customers } = await db.from("customers").select("id, code, name").in("id", customerIds);
  const name = new Map((customers ?? []).map((c) => [c.id, `${c.code} ${c.name}`]));
  for (const w of wrong.slice(0, 15)) {
    console.log(`        ${name.get(w.last.customerId) ?? w.last.customerId} · ${w.last.sku}: remembered ${w.mem.price}, last billed ${w.last.price} on ${String(w.last.at).slice(0, 10)}`);
  }
  for (const x of missing.slice(0, 15)) {
    console.log(`        ${name.get(x.last.customerId) ?? x.last.customerId} · ${x.last.sku}: billed ${x.last.price} on ${String(x.last.at).slice(0, 10)}, nothing remembered`);
  }
}

console.log(
  problems === 0
    ? "\nPASS — what the book remembers is what customers were last billed.\n"
    : `\nLOOK — ${problems} check(s) above need a decision. Nothing was changed.\n`
);
process.exit(problems === 0 ? 0 : 1);
