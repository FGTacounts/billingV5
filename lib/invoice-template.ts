// Shared pieces of the company invoice layout, used by the Excel export
// (managers, with hidden cost/profit columns) and the PDF export. Port of
// InvoiceTemplate.swift — keep these values in sync with the approved invoice.

import { t } from "@/lib/i18n";

export const InvoiceTemplate = {
  companyName: "FAMLIST GENERAL TRADING L.L.C. UAE",
  tagline: t("documents.companyTagline"),
  licenseNo: "900037",
  trn: "100550392300003",
  email: "sales@glitterstores.com",
  location: "Dubai UAE",
  phone: "0506291370",
  paymentTerms: t("documents.paymentTermsValue"),
  // First Abu Dhabi Bank, exactly as the owner's own statement sheet prints it
  // (2026-09-18; it was a CBD account before). The IBAN passes its checksum.
  // The account number line ends ...000 on the owner's sheet while the IBAN
  // embeds ...001 — printed as provided, and flagged to the owner to confirm.
  bankLine1: "AED ACCOUNT NO: 1001327119433000, NAME: FAMLIST GENERAL TRADING LLC,",
  bankLine2: "IBAN : AE090351001327119433001, SWIFT CODE : NBADAEAA",
  footerNote1: t("documents.invoiceFooterQueryNote"),
  footerNote2: t("documents.invoiceFooterGeneratedNote"),
};

// What an order's invoice prints under Payment Terms: the terms a manager
// wrote on that order (RUN-ME-37), or the standard ones when none were.
export const PAYMENT_TERMS_MAX = 40;
export function paymentTermsFor(order: { payment_terms?: string | null }): string {
  return order.payment_terms?.trim() || InvoiceTemplate.paymentTerms;
}

// The customer's VAT No as an order's invoice prints it (RUN-ME-38): the
// number a manager wrote on that order, none when they removed it ("" on the
// order), else the customer's own. "" means print no VAT No line.
export const VAT_NO_MAX = 30;
export function customerVatNoFor(order: {
  invoice_customer_vat_no?: string | null;
  customer?: { vat_number?: string | null } | null;
}): string {
  if (order.invoice_customer_vat_no != null) return order.invoice_customer_vat_no.trim();
  return order.customer?.vat_number?.trim() ?? "";
}

// A VAT rate as printed and shown: 0.05 → "5%", 0.025 → "2.5%", 0 → "0%".
export function formatVatRate(rate: number): string {
  return `${Number((rate * 100).toFixed(2))}%`;
}

// The business's day. Invoices are made on the server, which runs in UTC:
// read there, an order billed at 01:30 in Dubai would be dated the day before.
export const BUSINESS_TIME_ZONE = "Asia/Dubai";
const businessDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: BUSINESS_TIME_ZONE,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

/** Day, month (1–12) and year of an instant, in Dubai. */
function dayInDubai(d: Date): { dd: string; mm: string; yyyy: string } {
  const part = (type: string) => businessDay.formatToParts(d).find((p) => p.type === type)?.value ?? "";
  return { dd: part("day"), mm: part("month"), yyyy: part("year") };
}

export function invoiceDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const { dd, mm, yyyy } = dayInDubai(d);
  return `${dd}.${mm}.${yyyy}`;
}

// Due Date = invoice date + the customer's overdue-threshold window — the
// only "payment terms in days" figure the schema actually stores per
// customer (there's no separate PO-level due-date field).
export function dueDate(iso: string, thresholdDays: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // Dubai keeps no daylight saving, so a day is always 24 hours there.
  return invoiceDate(new Date(d.getTime() + thresholdDays * 86_400_000).toISOString());
}

// What an order's invoice prints as its Due Date: the date a manager set in
// Additional changes, or an approved extension moved it to — both are
// orders.extended_due_date, a calendar date — else the reckoned one above.
export function dueDateFor(
  order: { extended_due_date?: string | null; billed_at?: string | null; updated_at: string; created_at: string },
  thresholdDays: number
): string {
  const set = /^(\d{4})-(\d{2})-(\d{2})/.exec(order.extended_due_date ?? "");
  if (set) return `${set[3]}.${set[2]}.${set[1]}`;
  return dueDate(order.billed_at ?? order.updated_at ?? order.created_at, thresholdDays);
}

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// File naming convention (Order Flow & Additions §2): INV{number}.{MON}{YY}
// — applied to every PDF/Excel download, including each entry inside a
// bulk "Download All" zip. Orders without an invoice number yet (drafts,
// pending, in-pipeline) fall back to "DRAFT" rather than fabricating one.
export function invoiceFileBase(invoiceNumber: string | number | null, dateIso: string): string {
  const d = new Date(dateIso);
  const day = isNaN(d.getTime()) ? null : dayInDubai(d);
  const mon = day ? MONTH_ABBR[Number(day.mm) - 1] : "";
  const yy = day ? day.yyyy.slice(-2) : "";
  const num = invoiceNumber != null ? String(invoiceNumber) : "DRAFT";
  return `INV${num}.${mon}${yy}`;
}

const ONES = [
  "ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
  "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
  "SEVENTEEN", "EIGHTEEN", "NINETEEN",
];
const TENS = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];

function spellUnder1000(n: number): string {
  let out = "";
  if (n >= 100) {
    out += ONES[Math.floor(n / 100)] + " HUNDRED";
    n %= 100;
    if (n) out += " ";
  }
  if (n >= 20) {
    out += TENS[Math.floor(n / 10)];
    if (n % 10) out += " " + ONES[n % 10];
  } else if (n > 0) {
    out += ONES[n];
  }
  return out;
}

export function spellOutPublic(num: number): string {
  return spellOut(num);
}

function spellOut(num: number): string {
  if (num === 0) return "ZERO";
  const scales = [
    { v: 1_000_000_000, name: "BILLION" },
    { v: 1_000_000, name: "MILLION" },
    { v: 1_000, name: "THOUSAND" },
  ];
  let n = num;
  const parts: string[] = [];
  for (const { v, name } of scales) {
    if (n >= v) {
      parts.push(spellUnder1000(Math.floor(n / v)) + " " + name);
      n %= v;
    }
  }
  if (n > 0) parts.push(spellUnder1000(n));
  return parts.join(" ");
}

// Template wording, e.g. "forty-eight UAE Dirham eighty-three fils".
export function amountInWordsInvoice(amount: number): string {
  const dirhams = Math.floor(amount);
  const fils = Math.round((amount - dirhams) * 100);
  const hyphenate = (s: string) =>
    s.toLowerCase()
      .replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety) (one|two|three|four|five|six|seven|eight|nine)\b/g, "$1-$2");
  let out = `${hyphenate(spellOutPublic(dirhams))} UAE Dirham`;
  if (fils > 0) out += ` ${hyphenate(spellOutPublic(fils))} fils`;
  return out;
}
