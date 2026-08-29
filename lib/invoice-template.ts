// Shared pieces of the company invoice layout, used by the Excel export
// (managers, with hidden cost/profit columns) and the PDF export. Port of
// InvoiceTemplate.swift — keep these values in sync with the approved invoice.

export const InvoiceTemplate = {
  companyName: "FAMLIST GENERAL TRADING L.L.C. UAE",
  tagline: "GLOBAL TRADE & DISTRIBUTION UAE",
  licenseNo: "900037",
  trn: "100550392300003",
  email: "sales@glitterstores.com",
  location: "Dubai UAE",
  phone: "0506291370",
  paymentTerms: "INVOICE TO 30 DAYS",
  bankLine1: "AED ACCOUNT NO: 1002539516, NAME: FAMLIST GENERAL TRADING LLC,",
  bankLine2: "IBAN : AE650230000001002539516, SWIFT CODE : CBDUAEAD",
  footerNote1:
    "Invoice deemed correct if no query reach us within 3 days from the date of delivery",
  footerNote2:
    "This is a computer generated invoice and henceforth require no stamp and signature.",
};

export function invoiceDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

// Due Date = invoice date + the customer's overdue-threshold window — the
// only "payment terms in days" figure the schema actually stores per
// customer (there's no separate PO-level due-date field).
export function dueDate(iso: string, thresholdDays: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + thresholdDays);
  return invoiceDate(d.toISOString());
}

const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// File naming convention (Order Flow & Additions §2): INV{number}.{MON}{YY}
// — applied to every PDF/Excel download, including each entry inside a
// bulk "Download All" zip. Orders without an invoice number yet (drafts,
// pending, in-pipeline) fall back to "DRAFT" rather than fabricating one.
export function invoiceFileBase(invoiceNumber: string | number | null, dateIso: string): string {
  const d = new Date(dateIso);
  const mon = isNaN(d.getTime()) ? "" : MONTH_ABBR[d.getMonth()];
  const yy = isNaN(d.getTime()) ? "" : String(d.getFullYear()).slice(-2);
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

// "ONE THOUSAND EIGHTY FOUR AED AND TWENTY THREE FILLS"
export function amountInWords(amount: number): string {
  const dirhams = Math.floor(amount);
  const fils = Math.round((amount - dirhams) * 100);
  let text = spellOut(dirhams) + " AED";
  if (fils > 0) text += " AND " + spellOut(fils) + " FILLS";
  return text;
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
