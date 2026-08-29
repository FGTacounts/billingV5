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
  if (salesman_id !== undefined) patch.salesman_id = salesman_id || null;
  if (po_number !== undefined) patch.po_number = po_number || null;

  const supabase = supabaseServer();
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
