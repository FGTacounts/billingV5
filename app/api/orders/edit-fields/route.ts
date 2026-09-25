import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { stampEdited } from "@/lib/orders-server";
import { t } from "@/lib/i18n";

export const runtime = "nodejs";

// §Orders: "Manager has complete flexibility over an order at any stage
// (invoice number, customer, salesman, PO number editable)" — Manager-only,
// works regardless of order status (unlike the draft/pending-only line-item
// edit route). po_number degrades gracefully until its migration is run.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: t("common.managerAccessRequired") }, { status: 403 });
  }

  const { orderId, invoice_number, customer_id, salesman_id, po_number, billed_at } = (await req.json()) as {
    orderId: string;
    invoice_number?: string | null;
    customer_id?: string | null;
    salesman_id?: string | null;
    po_number?: string | null;
    billed_at?: string;
  };
  if (!orderId) return NextResponse.json({ error: t("orders.orderIdRequired") }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (invoice_number !== undefined) patch.invoice_number = invoice_number || null;
  if (customer_id !== undefined) patch.customer_id = customer_id || null;
  if (po_number !== undefined) patch.po_number = po_number || null;
  // The billing date (RUN-ME-27). The database marks a date written here as
  // set by hand, so later status changes leave it alone — which is why the
  // form only sends it when it was actually changed.
  if (billed_at !== undefined) {
    const when = new Date(billed_at);
    if (!billed_at || Number.isNaN(when.getTime())) {
      return NextResponse.json({ error: t("orders.billingDateInvalid") }, { status: 400 });
    }
    patch.billed_at = when.toISOString();
  }

  const supabase = supabaseCaller();

  // An order always names the person who billed it. Clearing that is how a
  // sale ends up counted for nobody on the Sales page, so it is refused
  // here rather than only discouraged in the form; and the id has to be a
  // real staff member, not a stale one pasted in.
  if (salesman_id !== undefined) {
    if (!salesman_id) {
      return NextResponse.json(
        { error: t("orders.salesmanRequired") },
        { status: 400 }
      );
    }
    const { data: seller, error: sellerErr } = await supabase
      .from("users")
      .select("id, is_active")
      .eq("id", salesman_id)
      .maybeSingle();
    if (sellerErr) return NextResponse.json({ error: sellerErr.message }, { status: 400 });
    if (!seller) {
      return NextResponse.json({ error: t("orders.salesmanNotStaff") }, { status: 400 });
    }
    patch.salesman_id = salesman_id;
  }
  const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
  // Matched on the column's name: a write to a column PostgREST does not know
  // is refused as PGRST204, a read as 42703, and both name it.
  if (error && billed_at !== undefined && /billed_at/.test(error.message)) {
    return NextResponse.json({ error: t("orders.billingDateNeedsSql") }, { status: 409 });
  }
  if (error && po_number !== undefined) {
    // po_number column may not exist yet — retry without it.
    const { po_number: _drop, ...rest } = patch;
    const retry = await supabase.from("orders").update(rest).eq("id", orderId);
    if (retry.error) return NextResponse.json({ error: retry.error.message }, { status: 400 });
    const stampedRetry = await stampEdited(supabase, orderId, user.id);
    return NextResponse.json({ ok: true, po_number_saved: false, edited_stamped: stampedRetry });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  // Changing what an order says about itself is an edit like any other, so
  // it carries the Edited stamp (RUN-ME-19). Best-effort: an un-migrated
  // database still saves the change.
  const stamped = await stampEdited(supabase, orderId, user.id);
  return NextResponse.json({ ok: true, po_number_saved: true, edited_stamped: stamped });
}
