// Header aliasing for bulk import (§Products/§Customers/§Expense: "give
// them an option to download sample data sheet"). The user's real source
// files (Billing Customers.xlsx, Articles & Stock V5.0.xlsx, V5.0
// Reports.xlsx — see FGT_Billing_Supabase_Schema.xlsx for the exact
// column-by-column mapping) use their own header names, not our snake_case
// DB field names. Rather than force a reformat, recognize both: the sample
// sheet we hand back uses their real headers, and any upload gets its
// headers normalized against this alias table before hitting the API.
//
// parseSpreadsheetFile() already lowercases headers and turns spaces/dashes
// into underscores (e.g. "CUSTOMER NAME" -> "customer_name", "VAT NO" ->
// "vat_no") — the alias keys below are written in that already-normalized
// form.

function normalizeKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function remapHeaders(
  rows: Record<string, string>[],
  aliases: Record<string, string[]>
): Record<string, string>[] {
  const lookup = new Map<string, string>();
  for (const [canonical, alts] of Object.entries(aliases)) {
    lookup.set(normalizeKey(canonical), canonical);
    for (const alt of alts) lookup.set(normalizeKey(alt), canonical);
  }
  return rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      const canonical = lookup.get(normalizeKey(key)) ?? key;
      if (!(canonical in out) || out[canonical] === "") out[canonical] = value;
    }
    return out;
  });
}

// Products <- Articles & Stock V5.0.xlsx, STOCK sheet.
export const PRODUCT_ALIASES: Record<string, string[]> = {
  sku: ["article"],
  description: ["desc"],
  price: [],
  cost: [],
  stock_on_hand: ["stock", "soh"],
  default_qty: ["default_qty", "defaultqty"],
  rack_location: ["rack"],
  barcode: [],
  category: ["product_category"],
  is_active: ["active"],
};

// Customers <- Billing Customers.xlsx (primary) / Statement sheet naming.
export const CUSTOMER_ALIASES: Record<string, string[]> = {
  name: ["customer_name"],
  code: ["customer_number"],
  district: ["area"],
  address: [],
  group_name: ["group"],
  phone: ["contact_details"],
  vat_number: ["vat_no", "vat"],
  overdue_threshold_days: [],
};

// Orders <- a day's orders in one sheet, one row per line item. Rows sharing
// an invoice value become one order; without that column the whole file is
// read as a single order.
export const ORDER_ALIASES: Record<string, string[]> = {
  invoice: ["invoice_no", "invoice_number", "inv", "invoice_#", "order_no", "order_number"],
  customer: ["customer_code", "code", "customer_name", "cust_code", "shop"],
  sku: ["article", "article_no", "item", "item_no", "item_code", "product", "product_code"],
  qty: ["quantity", "qnty", "pcs", "units", "count"],
  price: ["rate", "unit_price", "unit_rate"],
  salesman: ["sales_exec", "sales", "rep", "salesperson"],
};

// Expenses <- V5.0 Reports.xlsx, FIXED/VARIABLE EXPENSE + PURCHASE sheets.
export const EXPENSE_ALIASES: Record<string, string[]> = {
  type: [],
  category: [],
  description: [],
  amount: [],
  date: ["expense_date"],
  notes: [],
  // Whose expense it is — matched by name against the staff list.
  salesman: ["salesman_name", "sales_man", "staff", "employee"],
};

// A lone "-" is this workbook's placeholder for "no value" (§products:
// "Some rows use '-' as a placeholder for 'no rack'") — reads as literal
// text otherwise, not blank.
export function cleanDashPlaceholder(value: string | undefined | null): string {
  const v = (value ?? "").trim();
  return v === "-" ? "" : v;
}

// The real STOCK sheet has 9 article codes reused across more than one
// product row (§products: "need a tie-breaker before they can load") — a
// duplicate SKU within one import batch would otherwise crash the
// upsert(onConflict: "sku") with "ON CONFLICT DO UPDATE command cannot
// affect row a second time". Auto-suffix repeats instead of failing the
// whole import.
export function dedupeSkus<T extends { sku: string }>(rows: T[]): T[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = row.sku.trim().toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? row : { ...row, sku: `${row.sku}-${count + 1}` };
  });
}
