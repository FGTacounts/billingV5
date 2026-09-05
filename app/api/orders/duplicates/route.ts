import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Finding orders that were submitted twice.
//
// A double tap on Send, a re-imported spreadsheet, or a salesman resubmitting
// something they thought had failed all leave two orders that are the same
// order. Approving both bills the customer twice and takes the stock out
// twice, so a manager needs to see them side by side and pick one.
//
// Only orders still waiting to be reviewed are ever considered. Once the
// warehouse has touched an order, picks and quantities have diverged and the
// two are no longer interchangeable — the manager must sort those out by
// hand rather than have a tool guess.
//
// (The previous version of the app also had a tool for merging one invoice
// split across several spreadsheet rows. That was a symptom of writing to a
// spreadsheet, not of the business: an order here is one row with its own
// key and invoice numbers are unique, so it cannot happen and there is
// nothing to merge.)

interface DuplicateOrder {
  id: string;
  invoiceNumber: string | null;
  createdAt: string;
  customerName: string;
  salesman: string;
  itemCount: number;
  total: number;
}

export async function GET() {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { data: orders, error } = await admin
    .from("orders")
    .select("id, invoice_number, customer_id, new_customer_note, salesman_id, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const rows = orders ?? [];
  if (rows.length < 2) return NextResponse.json({ groups: [], duplicateCount: 0 });

  const { data: items } = await admin
    .from("order_items")
    .select("order_id, product_id, sku, ordered_qty, unit_price")
    .in(
      "order_id",
      rows.map((o) => o.id)
    );

  const byOrder = new Map<string, { key: string; count: number; total: number }>();
  for (const it of items ?? []) {
    const cur = byOrder.get(it.order_id) ?? { key: "", count: 0, total: 0 };
    cur.count += 1;
    cur.total += (it.unit_price ?? 0) * (it.ordered_qty ?? 0);
    byOrder.set(it.order_id, cur);
  }
  // The fingerprint is customer plus the set of item/quantity pairs, sorted,
  // so two orders match however their lines happen to be arranged.
  const lineKeys = new Map<string, string[]>();
  for (const it of items ?? []) {
    const list = lineKeys.get(it.order_id) ?? [];
    list.push(`${(it.product_id ?? it.sku ?? "").toString().toLowerCase()}:${it.ordered_qty}`);
    lineKeys.set(it.order_id, list);
  }

  const names = new Map<string, string>();
  const customerIds = [...new Set(rows.map((o) => o.customer_id).filter(Boolean))] as string[];
  if (customerIds.length) {
    const { data: customers } = await admin.from("customers").select("id, name").in("id", customerIds);
    for (const c of customers ?? []) names.set(c.id, c.name);
  }
  const salesmen = new Map<string, string>();
  const salesmanIds = [...new Set(rows.map((o) => o.salesman_id).filter(Boolean))] as string[];
  if (salesmanIds.length) {
    const { data: users } = await admin.from("users").select("id, full_name").in("id", salesmanIds);
    for (const u of users ?? []) salesmen.set(u.id, u.full_name);
  }

  const groups = new Map<string, DuplicateOrder[]>();
  for (const o of rows) {
    const lines = (lineKeys.get(o.id) ?? []).sort();
    // An order with no lines is not a duplicate of anything — it is a mistake
    // of a different kind, and grouping empties together would be noise.
    if (lines.length === 0) continue;
    const fingerprint = `${o.customer_id ?? o.new_customer_note ?? ""}|${lines.join(",")}`;
    const summary = byOrder.get(o.id);
    const entry: DuplicateOrder = {
      id: o.id,
      invoiceNumber: o.invoice_number,
      createdAt: o.created_at,
      customerName: o.customer_id
        ? names.get(o.customer_id) ?? "Unknown customer"
        : o.new_customer_note ?? "Unnamed customer",
      salesman: o.salesman_id ? salesmen.get(o.salesman_id) ?? "—" : "—",
      itemCount: summary?.count ?? 0,
      total: summary?.total ?? 0,
    };
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), entry]);
  }

  // Oldest first inside each group: that is the copy to keep, because it is
  // the one the salesman actually meant to send.
  const duplicates = [...groups.values()]
    .filter((g) => g.length > 1)
    .map((g) => g.sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)));

  return NextResponse.json({
    groups: duplicates,
    duplicateCount: duplicates.reduce((n, g) => n + (g.length - 1), 0),
  });
}

// Deletes exactly the orders the manager ticked — nothing is re-scanned or
// inferred here, so this can never remove something they did not choose.
// Guarded to `pending` server-side as well: an order that has moved on has
// stock or an invoice number behind it and must not be deleted by this tool.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { orderIds } = (await req.json()) as { orderIds?: string[] };
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return NextResponse.json({ error: "Nothing was selected to remove." }, { status: 400 });
  }

  let admin;
  try {
    admin = supabaseAdmin();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 501 });
  }

  const { data: safe, error: checkErr } = await admin
    .from("orders")
    .select("id")
    .in("id", orderIds)
    .eq("status", "pending");
  if (checkErr) return NextResponse.json({ error: checkErr.message }, { status: 500 });
  const deletable = (safe ?? []).map((o) => o.id);
  if (deletable.length === 0) {
    return NextResponse.json(
      { error: "Those orders have already moved on and were left alone." },
      { status: 409 }
    );
  }

  // Line items first: nothing else references a pending order.
  const { error: itemsErr } = await admin.from("order_items").delete().in("order_id", deletable);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });
  await admin.from("order_status_log").delete().in("order_id", deletable);
  await admin.from("payment_delay_notes").delete().in("order_id", deletable);

  const { error: delErr } = await admin.from("orders").delete().in("id", deletable);
  if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, deleted: deletable.length, skipped: orderIds.length - deletable.length });
}
