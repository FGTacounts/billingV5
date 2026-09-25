import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { resolveVatRate } from "@/lib/queries/zones";
import { toFils, toAed, billed } from "@/lib/money";
import { orderDiscount } from "@/lib/orders-server";

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

  const supabase = supabaseCaller();

  const { data: order, error: orderErr } = await supabase
    .from("orders")
    .select("id, status, invoice_number, customer_id, salesman_id")
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
    .select("id, product_id, unit_price, unit_cost, ordered_qty, picked_qty")
    .eq("order_id", orderId)
    .order("id");
  if (itemsErr) return NextResponse.json({ error: itemsErr.message }, { status: 500 });

  // Nothing is sold from an empty shelf. Each line is cut to what is on
  // hand, the cut is saved as the line's picked quantity so the invoice and
  // the stock agree, and the approver is told what was cut. Products that
  // share a shelf (RUN-ME-18) draw from one pool, so two linked SKUs on the
  // same order cannot together take more than the one figure.
  //
  // A product with no count kept (stock_on_hand null) is not capped and not
  // written: there is no figure to cut against or to deduct from.
  type StockRow = { id: string; sku: string; stock_on_hand: number | null; stock_group_id?: string | null };
  const productIds = [...new Set((items ?? []).map((it) => it.product_id).filter(Boolean))];
  let stockRows: StockRow[] = [];
  if (productIds.length) {
    let res: { data: unknown[] | null; error: { message: string } | null } = await supabase
      .from("products")
      .select("id, sku, stock_on_hand, stock_group_id")
      .in("id", productIds);
    // Before RUN-ME-18 has been run there is no group column: every product
    // is its own shelf.
    if (res.error && res.error.message.includes("stock_group_id")) {
      res = await supabase.from("products").select("id, sku, stock_on_hand").in("id", productIds);
    }
    if (res.error) return NextResponse.json({ error: res.error.message }, { status: 500 });
    stockRows = (res.data ?? []) as StockRow[];
  }
  const productById = new Map(stockRows.map((r) => [r.id, r]));

  const remainingByPool = new Map<string, number>();
  const anyProductInPool = new Map<string, string>();
  const capped: { sku: string; from: number; to: number }[] = [];
  const lineCuts: { id: string; picked_qty: number }[] = [];
  // Counted in fils, so the billed figures cannot carry a float artefact
  // into the invoice. See lib/money.ts.
  let subtotalFils = 0;
  for (const it of items ?? []) {
    let qty = it.picked_qty ?? it.ordered_qty ?? 0;
    const product = productById.get(it.product_id);
    if (product && product.stock_on_hand != null) {
      const pool = product.stock_group_id ?? product.id;
      if (!remainingByPool.has(pool)) {
        remainingByPool.set(pool, Math.max(0, product.stock_on_hand));
        anyProductInPool.set(pool, product.id);
      }
      const left = remainingByPool.get(pool) ?? 0;
      if (qty > left) {
        capped.push({ sku: product.sku, from: qty, to: left });
        qty = left;
        lineCuts.push({ id: it.id, picked_qty: qty });
      }
      remainingByPool.set(pool, left - qty);
    }
    subtotalFils += Math.round(toFils(it.unit_price) * qty);
  }

  // The cuts go on the lines before anything else is written, so an order
  // can never be approved with an invoice that says more than was deducted.
  for (const cut of lineCuts) {
    const { error } = await supabase.from("order_items").update({ picked_qty: cut.picked_qty }).eq("id", cut.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // One write per shelf. For a shared shelf the database copies the figure
  // to the other products in the group, so writing any one member is enough.
  for (const [pool, left] of remainingByPool) {
    const productId = anyProductInPool.get(pool);
    if (!productId) continue;
    await supabase.from("products").update({ stock_on_hand: left }).eq("id", productId);
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
  // The order-wide discount (RUN-ME-28) comes off before VAT, as it does in
  // manager_edit_order; 0 on a database without it.
  const discountFils = Math.round((await orderDiscount(supabase, orderId)) * 100);
  // VAT is rounded once, and the total is the two figures added — so the
  // lines on the invoice add up to the total printed on it.
  const { subtotal, vatAmount, total } = billed(toAed(Math.max(0, subtotalFils - discountFils)), vatRate);

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

  // Approval is the moment the order becomes an invoice, so it is the one
  // the salesman most needs to hear about. Best-effort: a failed bell must
  // not undo an approval that has already deducted stock.
  if (order.salesman_id && order.salesman_id !== user.id) {
    await supabase
      .from("notifications")
      .insert({
        user_id: order.salesman_id,
        type: "order_approved",
        title: invoiceNumber ? `Order approved — invoice #${invoiceNumber}` : "Order approved",
        body: `Approved by ${user.full_name}.`,
        is_read: false,
      })
      .then(undefined, () => {});
  }

  return NextResponse.json({ ok: true, invoiceNumber, capped });
}
