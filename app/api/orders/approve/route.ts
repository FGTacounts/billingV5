import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { resolveVatRate } from "@/lib/queries/zones";

export const runtime = "nodejs";

// Manager-only: finalizes the invoice, deducts stock, stamps the invoice
// number, and stores the total/subtotal/vat_amount on the order (there's no
// DB trigger doing this — see plan/README — so it's computed here from the
// picked quantities, matching "exports/invoice always use the picked qty").
// No RPC/transaction access, so this does its best with sequential
// read-then-write calls under the caller's own RLS session — acceptable at
// this app's concurrency (a Manager approves serially), not perfectly
// race-proof under simultaneous approvals of the same SKU.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { orderId } = await req.json();
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, invoice_number, customer_id")
    .eq("id", orderId)
    .maybeSingle();
  if (orderErr || !order) {
    return NextResponse.json({ error: "Order not found" }, { status: 404 });
  }
  // Normally only from Packed, but Manager can also "Approve now" earlier
  // in the pipeline to skip picking entirely (§1.3) — items without a
  // picked_qty yet just fall back to ordered_qty below, same as a partial
  // pick would.
  const APPROVABLE_STATUSES = ["accepted", "waiting", "picking", "packed"];
  if (!APPROVABLE_STATUSES.includes(order.status)) {
    return NextResponse.json(
      { error: `Order must be in the warehouse pipeline to approve (currently ${order.status})` },
      { status: 409 }
    );
  }

  const { data: items, error: itemsErr } = await supabase
    .from("order_items")
    .select("product_id, unit_price, unit_cost, ordered_qty, picked_qty")
    .eq("order_id", orderId);
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  const qtyByProduct = new Map<string, number>();
  let subtotal = 0;
  for (const it of items ?? []) {
    const qty = it.picked_qty ?? it.ordered_qty ?? 0;
    qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) ?? 0) + qty);
    subtotal += it.unit_price * qty;
  }

  for (const [productId, qty] of qtyByProduct) {
    const { data: product, error: pErr } = await supabase
      .from("products")
      .select("stock_on_hand")
      .eq("id", productId)
      .maybeSingle();
    if (pErr || !product) continue;
    const newStock = (product.stock_on_hand ?? 0) - qty;
    await supabase.from("products").update({ stock_on_hand: newStock }).eq("id", productId);
  }

  // §Orders: "the customer's last-billed price for that item should be the
  // saved/suggested default" — the sticky-price table this feeds
  // (customer_prices, read by NewOrderSheet's useLastPrices/addProduct) had
  // no write side at all until now, so it was always empty and "Use last
  // prices" never had anything to apply.
  if (order.customer_id) {
    const priceByProduct = new Map<string, number>();
    for (const it of items ?? []) priceByProduct.set(it.product_id, it.unit_price);
    const rows = [...priceByProduct.entries()].map(([product_id, price]) => ({
      customer_id: order.customer_id,
      product_id,
      price,
      updated_at: new Date().toISOString(),
    }));
    if (rows.length) {
      await supabase.from("customer_prices").upsert(rows, { onConflict: "customer_id,product_id" });
    }
  }

  const { data: settings } = await supabase
    .from("app_settings")
    .select("vat_rate")
    .limit(1)
    .maybeSingle();
  const fallbackVatRate = settings?.vat_rate ?? 0.05;

  // §Global zones: an order's VAT is the customer's zone rate (by country),
  // not always the flat app-wide rate — resolveVatRate degrades to
  // fallbackVatRate when the customer has no country set or the zones
  // tables don't exist yet.
  let customerCountry: string | null = null;
  if (order.customer_id) {
    const { data: cust } = await supabase.from("customers").select("country_code").eq("id", order.customer_id).maybeSingle();
    customerCountry = cust?.country_code ?? null;
  }
  const vatRate = await resolveVatRate(supabase, customerCountry, fallbackVatRate);
  const vatAmount = subtotal * vatRate;
  const total = subtotal + vatAmount;

  const { error: approveErr } = await supabase
    .from("orders")
    .update({ status: "approved", subtotal, vat_amount: vatAmount, total })
    .eq("id", orderId);
  if (approveErr) return NextResponse.json({ error: approveErr.message }, { status: 500 });

  await supabase
    .from("order_status_log")
    .insert({ order_id: orderId, changed_by: user.id, changed_at: new Date().toISOString() });

  // The invoice number is issued here, at approval, and nowhere else. Only
  // orders that actually become invoices consume a number, so the series has
  // no gaps.
  //
  // This used to read every invoice number and pick the highest in
  // JavaScript: two managers approving at the same moment both read the same
  // highest number and both wrote it, producing duplicates. The database now
  // does it under an advisory lock, which is gapless as well as race-free —
  // a Postgres sequence would have fixed the race but burns a number on a
  // failed transaction, leaving a hole.
  //
  // Idempotent, so a retried approval keeps the number it already has.
  let invoiceNumber: string | null = order.invoice_number ?? null;
  if (!invoiceNumber) {
    const { data: assigned, error: numberErr } = await supabase.rpc("assign_invoice_number", {
      order_id_param: orderId,
    });
    if (numberErr) {
      return NextResponse.json(
        { error: "Approved, but could not assign an invoice number." },
        { status: 500 }
      );
    }
    invoiceNumber = assigned as string;

    // Belt and braces, and it has already earned its keep: a database still
    // running the old numbering function hands back a number that is already
    // on another invoice. The uniqueness rule that makes this impossible
    // arrives with scratchpad/RUN-ME-all-pending.sql, and until that has been
    // run nothing else would notice — two invoices would quietly share a
    // number, which is the kind of thing only found at audit.
    //
    // So: if the number came back already in use, take it back off this order
    // and refuse. The order stays approved and simply has no number yet, which
    // is a state approval already handles — re-approving issues a fresh one
    // once the numbering is fixed.
    const { data: clash } = await supabase
      .from("orders")
      .select("id")
      .eq("invoice_number", invoiceNumber)
      .neq("id", orderId)
      .limit(1);
    if (clash && clash.length > 0) {
      await supabase.from("orders").update({ invoice_number: null }).eq("id", orderId);
      return NextResponse.json(
        {
          error:
            "Approved, but invoice number " +
            invoiceNumber +
            " is already in use, so it wasn't given one. Ask your administrator to finish setting up invoice numbering, then approve it again.",
        },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ ok: true, invoiceNumber });
}
