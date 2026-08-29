// Turns whatever the database or network threw into something a shop
// manager can act on.
//
// Without this, a failed save shows the raw Postgres text — things like
// 'duplicate key value violates unique constraint "products_sku_key"' or
// 'new row violates row-level security policy'. That tells a developer
// exactly what happened and tells everyone else nothing at all.
//
// `fallback` is the caller's own plain description of what was being
// attempted ("Couldn't save the customer"), used whenever the underlying
// error isn't one we recognise.

interface Rule {
  match: RegExp;
  message: (m: RegExpMatchArray) => string;
}

// Postgres constraint names are conventionally <table>_<column>_key etc, so
// the column is usually recoverable for a genuinely specific message.
const FIELD_LABELS: Record<string, string> = {
  sku: "SKU",
  code: "code",
  username: "username",
  email: "email address",
  barcode: "barcode",
  invoice_number: "invoice number",
  vat_number: "VAT number",
};

function labelFor(raw: string): string {
  return FIELD_LABELS[raw] ?? raw.replace(/_/g, " ");
}

const RULES: Rule[] = [
  {
    // Constraint names are <table>_<column>_key, and both halves can contain
    // underscores (customers_vat_number_key), so splitting on "_" and taking
    // one token guesses wrong. Match against the field names we actually
    // know instead, and stay generic when none of them fit.
    match: /duplicate key value violates unique constraint "([\w]+)"/i,
    message: (m) => {
      const constraint = m[1].replace(/_key$/, "");
      const field = Object.keys(FIELD_LABELS).find((f) => constraint.endsWith(`_${f}`));
      return field
        ? `That ${FIELD_LABELS[field]} is already used by another record.`
        : "That record already exists.";
    },
  },
  {
    match: /duplicate key value/i,
    message: () => "That record already exists.",
  },
  {
    match: /violates foreign key constraint/i,
    message: () =>
      "This is still linked to other records, so it can't be removed. Remove or reassign those first.",
  },
  {
    match: /violates row-level security|permission denied|insufficient privilege/i,
    message: () => "You don't have permission to do that.",
  },
  {
    match: /violates check constraint/i,
    message: () => "One of the values isn't allowed. Check the numbers and try again.",
  },
  {
    match: /null value in column "(\w+)"/i,
    message: (m) => `${labelFor(m[1])[0].toUpperCase()}${labelFor(m[1]).slice(1)} is required.`,
  },
  {
    match: /column .* does not exist|schema cache|PGRST\d+/i,
    message: () => "That feature isn't enabled on your account yet. Ask your administrator.",
  },
  {
    match: /JWT|not authenticated|invalid token|session/i,
    message: () => "Your session has expired. Please sign in again.",
  },
  {
    match: /failed to fetch|networkerror|load failed|timeout/i,
    message: () => "Couldn't reach the server. Check your connection and try again.",
  },
];

export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw =
    e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (!raw) return fallback;

  for (const rule of RULES) {
    const m = raw.match(rule.match);
    if (m) return rule.message(m);
  }

  // An unrecognised message that already reads like a sentence written for a
  // person (no SQL, no identifiers, reasonably short) is better than a
  // generic fallback — a lot of our own thrown errors are already friendly.
  const looksHumanWritten =
    raw.length < 120 &&
    !/["{}()]|_[a-z]|::|SELECT |INSERT |UPDATE /i.test(raw) &&
    /^[A-Z]/.test(raw);
  return looksHumanWritten ? raw : fallback;
}
