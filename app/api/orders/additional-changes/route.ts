import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { customerVatRate, managerEditOrder, recalcOrderTotals, stampEdited } from "@/lib/orders-server";
import { billed } from "@/lib/money";
import { PAYMENT_TERMS_MAX, VAT_NO_MAX } from "@/lib/invoice-template";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// Additional changes on an order (owner, 2026-10-22): its payment terms, its
// VAT (the customer's rate, none, or another), the VAT numbers its invoice
// prints, its due date and the discount on the whole order. Manager and
// admin, at any stage — the same people and stages as Edit order details.
//
// A change to the VAT or the discount re-adds the order through
// manager_edit_order, which takes the order's own rate first (RUN-ME-38), so
// the stored subtotal, VAT and total — and with them the customer's balance
// and the VAT report — follow at once. If that refuses (a discount bigger
// than the order, say), the fields written just before are put back.

const RUN_ME_38_COLUMNS = /vat_rate_override|invoice_customer_vat_no|invoice_shows_our_trn/;

function managerOnly(role: string | undefined) {
  return role === "manager" || role === "admin";
}

// What the sheet needs that the order itself does not carry: whether the
// database has the columns yet, and the rate the customer would be billed at.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user || !managerOnly(user.role)) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }
  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();
  const [{ data: order }, probe, terms] = await Promise.all([
    supabase.from("orders").select("customer_id").eq("id", orderId).maybeSingle(),
    supabase.from("orders").select("vat_rate_override").eq("id", orderId).maybeSingle(),
    supabase.from("orders").select("payment_terms").eq("id", orderId).maybeSingle(),
  ]);
  const standardRate = await customerVatRate(supabase, (order?.customer_id as string | null) ?? null);
  return NextResponse.json({
    standardRate,
    supported: !probe.error,
    termsSupported: !terms.error,
  });
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || !managerOnly(user.role)) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const body = (await req.json()) as {
    orderId?: string;
    vat_rate_override?: number | null;
    invoice_customer_vat_no?: string | null;
    invoice_shows_our_trn?: boolean;
    extended_due_date?: string | null;
    payment_terms?: string | null;
    discount?: number;
  };
  const { orderId } = body;
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  // Only what the form sends is changed; it sends only what was changed.
  const patch: Record<string, unknown> = {};
  if (body.vat_rate_override !== undefined) {
    const rate = body.vat_rate_override;
    if (rate !== null && (!Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 1)) {
      return NextResponse.json({ error: t("orders.vatRateInvalid") }, { status: 400 });
    }
    // Four places of a fraction is two of a percentage: 2.5% is 0.025.
    patch.vat_rate_override = rate === null ? null : Math.round(Number(rate) * 10000) / 10000;
  }
  if (body.invoice_customer_vat_no !== undefined) {
    const no = body.invoice_customer_vat_no;
    if (no !== null && no.trim().length > VAT_NO_MAX) {
      return NextResponse.json({ error: t("orders.vatNoTooLong", { max: VAT_NO_MAX }) }, { status: 400 });
    }
    // null: the customer's own. "": none printed.
    patch.invoice_customer_vat_no = no === null ? null : no.trim();
  }
  if (body.invoice_shows_our_trn !== undefined) patch.invoice_shows_our_trn = body.invoice_shows_our_trn !== false;
  if (body.extended_due_date !== undefined) {
    const due = body.extended_due_date;
    if (due !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(new Date(due).getTime()))) {
      return NextResponse.json({ error: t("orders.dueDateInvalid") }, { status: 400 });
    }
    patch.extended_due_date = due || null;
  }
  if (body.payment_terms !== undefined) {
    const terms = (body.payment_terms ?? "").trim();
    if (terms.length > PAYMENT_TERMS_MAX) {
      return NextResponse.json({ error: t("orders.paymentTermsTooLong", { max: PAYMENT_TERMS_MAX }) }, { status: 400 });
    }
    patch.payment_terms = terms || null;
  }
  const discount = body.discount === undefined ? undefined : Number(body.discount);
  if (discount !== undefined && (!Number.isFinite(discount) || discount < 0)) {
    return NextResponse.json({ error: t("orders.orderDiscountInvalid") }, { status: 400 });
  }
  if (Object.keys(patch).length === 0 && discount === undefined) return NextResponse.json({ ok: true });

  const supabase = supabaseCaller();
  const { data: order, error: readErr } = await supabase
    .from("orders")
    .select("id, status, customer_id, subtotal")
    .eq("id", orderId)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 400 });
  if (!order) return NextResponse.json({ error: t("orders.orderNotFound") }, { status: 404 });
  if (order.status === "cancelled") return NextResponse.json({ error: t("orders.inTrash") }, { status: 409 });

  // What the fields were, so a refused recount can put them back.
  let before: Record<string, unknown> = {};
  const columns = Object.keys(patch);
  if (columns.length) {
    const { data, error } = await supabase.from("orders").select(columns.join(", ")).eq("id", orderId).maybeSingle();
    if (error) return refusal(error.message);
    before = (data as Record<string, unknown> | null) ?? {};

    const { error: writeErr } = await supabase.from("orders").update(patch).eq("id", orderId);
    if (writeErr) return refusal(writeErr.message);
  }

  const recount = patch.vat_rate_override !== undefined || discount !== undefined;
  if (recount) {
    const failure = await recountTotals(supabase, orderId, order, discount);
    if (failure) {
      if (columns.length) await supabase.from("orders").update(before).eq("id", orderId);
      return failure;
    }
  }

  // An edit like any other, so it carries the Edited stamp (best effort).
  await stampEdited(supabase, orderId, user.id);
  return NextResponse.json({ ok: true });
}

// A refused write, told in the owner's words where a missing column is why.
function refusal(message: string) {
  if (RUN_ME_38_COLUMNS.test(message)) {
    return NextResponse.json({ error: t("orders.additionalChangesNeedsSql") }, { status: 409 });
  }
  if (/payment_terms/.test(message)) {
    return NextResponse.json({ error: t("orders.paymentTermsNeedsSql") }, { status: 409 });
  }
  return NextResponse.json({ error: message }, { status: 400 });
}

// Re-adds the order at its new rate or discount. An order with lines goes
// through manager_edit_order, as every other manager change does. An invoice
// imported without lines has only its stored subtotal: its VAT is worked out
// again on that, and it cannot take a discount here.
async function recountTotals(
  supabase: ReturnType<typeof supabaseCaller>,
  orderId: string,
  order: { customer_id: string | null; subtotal: number | null },
  discount: number | undefined
): Promise<NextResponse | null> {
  const { count, error: countErr } = await supabase
    .from("order_items")
    .select("id", { count: "exact", head: true })
    .eq("order_id", orderId);
  if (countErr) return NextResponse.json({ error: countErr.message }, { status: 400 });

  if (!count) {
    if (discount !== undefined && discount > 0) {
      return NextResponse.json({ error: t("orders.discountNeedsLines") }, { status: 400 });
    }
    const { data } = await supabase.from("orders").select("vat_rate_override").eq("id", orderId).maybeSingle();
    const own = (data as { vat_rate_override: number | null } | null)?.vat_rate_override;
    const rate = own == null ? await customerVatRate(supabase, order.customer_id) : Number(own);
    const { subtotal, vatAmount, total } = billed(Number(order.subtotal) || 0, rate);
    const { error } = await supabase
      .from("orders")
      .update({ subtotal, vat_amount: vatAmount, total })
      .eq("id", orderId);
    return error ? NextResponse.json({ error: error.message }, { status: 400 }) : null;
  }

  const result = await managerEditOrder(supabase, orderId, [], discount);
  if (result.ok) return null;
  if (!result.missing) return NextResponse.json({ error: result.message }, { status: 400 });
  // Before RUN-ME-28 there is nowhere to keep a discount; the VAT alone can
  // still be re-added the old way.
  if (discount !== undefined) return NextResponse.json({ error: t("orders.needsDatabaseUpdate") }, { status: 409 });
  await recalcOrderTotals(supabase, orderId, order.customer_id);
  return null;
}
