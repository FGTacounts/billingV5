import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getAppUser } from "@/lib/auth";
import { supabaseServer } from "@/lib/supabase/server";
import { fetchOrders } from "@/lib/queries/orders";
import { fetchCustomers } from "@/lib/queries/customers";
import { fetchProductsServer } from "@/lib/products-server";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchPayments } from "@/lib/queries/payments";
import { subtotal, vat, total } from "@/lib/money";

export const runtime = "nodejs";

// Manager-only (§11: "only Manager can export Excel").
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }

  const type = req.nextUrl.searchParams.get("type") ?? "orders";
  const supabase = supabaseServer();
  const wb = new ExcelJS.Workbook();

  if (type === "orders") {
    const sheet = wb.addWorksheet("Orders");
    sheet.columns = [
      { header: "Invoice #", key: "invoice", width: 12 },
      { header: "Date", key: "date", width: 14 },
      { header: "Customer", key: "customer", width: 30 },
      { header: "Salesman", key: "salesman", width: 18 },
      { header: "Status", key: "status", width: 14 },
      { header: "Subtotal", key: "subtotal", width: 14 },
      { header: "VAT", key: "vat", width: 12 },
      { header: "Total", key: "total", width: 14 },
    ];
    const orders = await fetchOrders(supabase, { limit: 1000 });
    for (const o of orders) {
      // orders.subtotal/vat_amount/total are stored once approved; before
      // that, fall back to computing from the live line items.
      let sub = o.subtotal;
      let vatAmt = o.vat_amount;
      let tot = o.total;
      if (sub == null || vatAmt == null || tot == null) {
        const { data: items } = await supabase
          .from("order_items_safe")
          .select("unit_price, ordered_qty, picked_qty")
          .eq("order_id", o.id);
        const rows = items ?? [];
        sub = subtotal(rows);
        vatAmt = vat(rows);
        tot = total(rows);
      }
      sheet.addRow({
        invoice: o.invoice_number ?? "",
        date: new Date(o.created_at).toLocaleDateString(),
        customer: o.customer?.name ?? o.new_customer_note ?? "",
        salesman: o.salesman?.full_name ?? "",
        status: o.status,
        subtotal: sub,
        vat: vatAmt,
        total: tot,
      });
    }
  } else if (type === "customers") {
    // Column names match Billing Customers.xlsx / the Statement sheet
    // (§FGT_Billing_Supabase_Schema.xlsx) so this export can be re-uploaded
    // via Import as-is, round-trip.
    const sheet = wb.addWorksheet("Customers");
    sheet.columns = [
      { header: "Code", key: "code", width: 12 },
      { header: "CUSTOMER NAME", key: "name", width: 32 },
      { header: "GROUP NAME", key: "group", width: 20 },
      { header: "District", key: "district", width: 20 },
      { header: "Address", key: "address", width: 30 },
      { header: "VAT NO", key: "vat", width: 20 },
      { header: "Contact Details", key: "phone", width: 16 },
    ];
    const customers = await fetchCustomers(supabase);
    for (const c of customers) {
      sheet.addRow({
        code: c.code,
        name: c.name,
        group: c.group_name ?? "",
        district: c.district ?? "",
        address: c.address ?? "",
        vat: c.vat_number ?? "",
        phone: c.phone ?? "",
      });
    }
  } else if (type === "products") {
    // Column names match Articles & Stock V5.0.xlsx's STOCK sheet
    // (§FGT_Billing_Supabase_Schema.xlsx) so this export can be re-uploaded
    // via Import as-is, round-trip.
    const sheet = wb.addWorksheet("Products");
    sheet.columns = [
      { header: "ARTICLE", key: "sku", width: 14 },
      { header: "DESCRIPTION", key: "name", width: 32 },
      { header: "Category", key: "category", width: 18 },
      { header: "PRICE", key: "price", width: 12 },
      { header: "Cost", key: "cost", width: 12 },
      { header: "Stock", key: "soh", width: 12 },
      { header: "Default Qty", key: "defaultQty", width: 12 },
      { header: "Rack", key: "rack", width: 12 },
      { header: "BARCODE", key: "barcode", width: 18 },
    ];
    const products = await fetchProductsServer(supabaseAdmin(), { isManager: true, activeOnly: false });
    for (const p of products) {
      sheet.addRow({
        sku: p.sku,
        name: p.name,
        category: p.category ?? "",
        price: p.price,
        cost: p.cost ?? "",
        soh: p.stock_on_hand ?? "",
        defaultQty: p.default_qty,
        rack: p.rack_location ?? "",
        barcode: p.barcode ?? "",
      });
    }
  } else if (type === "payments") {
    const sheet = wb.addWorksheet("Payments");
    sheet.columns = [
      { header: "Date", key: "date", width: 14 },
      { header: "Customer", key: "customer", width: 30 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Method", key: "method", width: 12 },
      { header: "Status", key: "status", width: 12 },
    ];
    const payments = await fetchPayments(supabase);
    for (const p of payments) {
      sheet.addRow({
        date: new Date(p.created_at).toLocaleDateString(),
        customer: p.customer?.name ?? "",
        amount: p.amount,
        method: p.cheque_number ? "Cheque" : "Cash",
        status: p.status,
      });
    }
  } else if (type === "expenses") {
    const sheet = wb.addWorksheet("Expenses");
    sheet.columns = [
      { header: "Date", key: "date", width: 14 },
      { header: "Type", key: "type", width: 12 },
      { header: "Category", key: "category", width: 20 },
      { header: "Description", key: "description", width: 30 },
      { header: "Amount", key: "amount", width: 14 },
      { header: "Notes", key: "notes", width: 30 },
    ];
    const { data: expenses } = await supabaseAdmin()
      .from("expenses")
      .select("date, type, category, description, amount, notes")
      .order("date", { ascending: false });
    for (const e of expenses ?? []) {
      sheet.addRow({
        date: new Date(e.date).toLocaleDateString(),
        type: e.type,
        category: e.category ?? "",
        description: e.description ?? "",
        amount: e.amount,
        notes: e.notes ?? "",
      });
    }
  } else {
    return NextResponse.json({ error: "Unknown export type" }, { status: 400 });
  }

  const buffer = await wb.xlsx.writeBuffer();
  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${type}.xlsx"`,
    },
  });
}
