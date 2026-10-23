import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseCaller } from "@/lib/supabase/server";
import { fetchOrder, fetchOrderItems } from "@/lib/queries/orders";
import { parseLineSort } from "@/lib/lineSort";
import { buildInvoicePdf } from "@/lib/pdf/invoice";
import { invoiceFileBase } from "@/lib/invoice-template";
import { t } from "@/lib/i18n";
import { BILLED_STATUSES } from "@/lib/billedStatuses";
import { orderVatRate } from "@/lib/orders-server";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: t("common.unauthorized") }, { status: 401 });

  const orderId = req.nextUrl.searchParams.get("orderId");
  if (!orderId) return NextResponse.json({ error: t("invoices.orderIdRequired") }, { status: 400 });

  const supabase = supabaseCaller();
  const order = await fetchOrder(supabase, orderId);
  if (!order) return NextResponse.json({ error: t("invoices.orderNotFound") }, { status: 404 });

  // Salesman/Warehouse exporting an in-progress order always get Performa,
  // never the official Tax Invoice wording (§4a/§11). But the Invoices
  // archive only ever lists approved orders, and per §4 "anyone downloading
  // from this screen gets the Tax Invoice regardless of role" — the
  // Performa/Tax split is an in-progress-export distinction only, not an
  // archive-access one.
  const requestedKind = req.nextUrl.searchParams.get("kind") === "performa" ? "performa" : "tax";
  const kind =
    (user.role === "manager" || user.role === "admin") ? requestedKind : BILLED_STATUSES.includes(order.status) ? "tax" : "performa";

  // The rate the order is billed at — its own (Additional changes), else its
  // customer's zone, else the app-wide one — as approval stores it.
  const [items, vatRate] = await Promise.all([
    fetchOrderItems(supabase, orderId),
    orderVatRate(supabase, order.id, order.customer_id ?? null),
  ]);
  // The order screen passes the sort it is showing, so the paper matches it.
  const sort = parseLineSort(req.nextUrl.searchParams.get("sort"));
  const bytes = await buildInvoicePdf(order, items, kind, vatRate, sort);
  const fileName = `${invoiceFileBase(order.invoice_number, order.billed_at ?? order.updated_at ?? order.created_at)}.pdf`;

  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${fileName}"`,
    },
  });
}
