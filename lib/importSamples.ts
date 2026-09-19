// The sample sheet each import hands out — one definition, used by the screen
// that owns the import and by Settings → Data, so a sheet filled in from
// either place uploads in either place and the two can never drift apart.
//
// A sample lists EVERY column its importer reads, optional ones included, and
// fills each with an example so the format is plain (a date, a yes/no, a
// country code). Only the columns marked required have to be in a real
// upload; a column left out, or a cell left blank, means "use the default" for
// a new row and "keep what is there" for an existing one. Header labels match
// the owner's own workbooks (Billing Customers.xlsx, Articles & Stock
// V5.0.xlsx, V5.0 Reports.xlsx); lib/importAliases.ts maps them to columns.
//
// Adding a column to an importer? Add it here in the same change.

export interface SampleHeader {
  key: string;
  required?: boolean;
}
type Example = Record<string, string | number>;

export const CUSTOMER_SAMPLE_HEADERS: SampleHeader[] = [
  { key: "Code", required: true },
  { key: "CUSTOMER NAME", required: true },
  { key: "District" },
  { key: "Address" },
  { key: "VAT NO" },
  { key: "GROUP NAME" },
  { key: "Contact Details" },
  { key: "Overdue Threshold Days" },
  { key: "Country" },
  { key: "Salesman" },
  { key: "Active" },
];

/** `code` is the next free customer number, worked out when the file is asked for. */
export function customerSampleExample(code: string): Example {
  return {
    Code: code,
    "CUSTOMER NAME": "Example Trading LLC",
    District: "DUBAI",
    Address: "Example street, Dubai",
    "VAT NO": "100000000000000",
    "GROUP NAME": "Example Group",
    "Contact Details": "0500000000",
    "Overdue Threshold Days": 90,
    Country: "AE",
    Salesman: "Salesman's name",
    Active: "yes",
  };
}

export const PRODUCT_SAMPLE_HEADERS: SampleHeader[] = [
  { key: "ARTICLE", required: true },
  { key: "DESCRIPTION", required: true },
  { key: "PRICE" },
  { key: "Cost" },
  { key: "Stock" },
  { key: "Default Qty" },
  { key: "Rack" },
  { key: "BARCODE" },
  { key: "Category" },
  { key: "Active" },
];

export const PRODUCT_SAMPLE_EXAMPLE: Example = {
  ARTICLE: "TTS100",
  DESCRIPTION: "Example product",
  PRICE: 25,
  Cost: 15,
  Stock: 100,
  "Default Qty": 12,
  Rack: "A1",
  BARCODE: "6290000000000",
  Category: "Example category",
  Active: "yes",
};

export const ORDER_SAMPLE_HEADERS: SampleHeader[] = [
  { key: "Invoice" },
  { key: "Customer", required: true },
  { key: "Article", required: true },
  { key: "Quantity", required: true },
  { key: "Price" },
  { key: "Salesman" },
  { key: "PO Number" },
  { key: "Note" },
];

// Price is filled here to show the format; in a real sheet leave it blank to
// charge what this customer last paid (or the list price), because a price
// written on the sheet overrides both.
export const ORDER_SAMPLE_EXAMPLE: Example = {
  Invoice: "A-1",
  Customer: "20001",
  Article: "TTS100",
  Quantity: 12,
  Price: 25,
  Salesman: "Salesman's name",
  "PO Number": "PO-1001",
  Note: "Deliver before noon",
};

export const EXPENSE_SAMPLE_HEADERS: SampleHeader[] = [
  { key: "TYPE", required: true },
  { key: "Category", required: true },
  { key: "AMOUNT", required: true },
  { key: "DATE", required: true },
  { key: "DESCRIPTION" },
  { key: "NOTES" },
  { key: "SALESMAN" },
];

export function expenseSampleExample(): Example {
  return {
    TYPE: "fixed",
    Category: "Rent",
    AMOUNT: 5000,
    DATE: new Date().toISOString().slice(0, 10),
    DESCRIPTION: "Warehouse rent",
    NOTES: "September",
    SALESMAN: "Salesman's name",
  };
}
