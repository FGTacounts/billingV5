import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrder, fetchOrderItems } from "@/lib/queries/orders";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ error: "orderId is required" }, { status: 400 });

  const supabase = supabaseServer();
  const order = await fetchOrder(supabase, orderId);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // Salesman/Warehouse exporting an in-progress order always get Performa,
  // never the official Tax Invoice wording (§4a/§11). But the Invoices
  // archive only ever lists delivered orders, and per §4 "anyone downloading
  // from this screen gets the Tax Invoice regardless of role" — the
  // Performa/Tax split is an in-progress-export distinction only, not an
  // archive-access one.
  const requestedKind = req.nextUrl.searchParams.get("kind") === "performa" ? "performa" : "tax";
  const kind =
    (user.role === "manager" || user.role === "admin") ? requestedKind : order.status === "delivered" ? "tax" : "performa";

  const [items, settings] = await Promise.all([
    fetchOrderItems(supabase, orderId),
    supabase.from("app_settings").select("vat_rate").limit(1).maybeSingle(),
  ]);
  const bytes = await buildInvoicePdf(order, items, kind, settings.data?.vat_rate);
  const fileName = `${invoiceFileBase(order.invoice_number, order.updated_at ?? order.created_at)}.pdf`;

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
    },
  });
}
