import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";

export const runtime = "nodejs";

// §Orders: "Manager has complete flexibility over an order at any stage
// (invoice number, customer, salesman, PO number editable)" — Manager-only,
// works regardless of order status (unlike the draft/pending-only line-item
// edit route). po_number degrades gracefully until its migration is run.
export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const { orderId, invoice_number, customer_id, salesman_id, po_number } = (await req.json()) as {
    orderId: string;
    invoice_number?: string | null;
    customer_id?: string | null;
    salesman_id?: string | null;
    po_number?: string | null;
  };
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (invoice_number !== undefined) patch.invoice_number = invoice_number || null;
  if (customer_id !== undefined) patch.customer_id = customer_id || null;
  if (po_number !== undefined) patch.po_number = po_number || null;

  const supabase = supabaseServer();

  // An order always names the person who billed it. Clearing that is how a
  // sale ends up counted for nobody on the Sales page, so it is refused
  // here rather than only discouraged in the form; and the id has to be a
  // real staff member, not a stale one pasted in.
  if (salesman_id !== undefined) {
    if (!salesman_id) {
      return NextResponse.json(
        { error: "An order has to stay linked to the person billing it." },
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
      return NextResponse.json({ error: "That salesman is not a staff member." }, { status: 400 });
    }
    patch.salesman_id = salesman_id;
  }
  const { error } = await supabase.from("orders").update(patch).eq("id", orderId);
  if (error && po_number !== undefined) {
    // po_number column may not exist yet — retry without it.
    const { po_number: _drop, ...rest } = patch;
    const retry = await supabase.from("orders").update(rest).eq("id", orderId);
    if (retry.error) return NextResponse.json({ error: retry.error.message }, { status: 400 });
    return NextResponse.json({ ok: true, po_number_saved: false });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true, po_number_saved: true });
}
