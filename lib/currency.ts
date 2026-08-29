// §Global: "Users can change the currency in the settings. (Prices change
// automatically according to latest currency prices)". Every amount in this
// app is stored and computed in AED — this is a display-only conversion
// layer, never applied to what's actually invoiced/recorded.
//
// open.er-api.com is used instead of the more common frankfurter.app
// because frankfurter only republishes the ECB's reference currencies,
// which don't include AED — open.er-api.com is free, needs no API key, and
// explicitly supports AED as a base currency.

export const SUPPORTED_CURRENCIES = [
  { code: "AED", label: "UAE Dirham" },
  { code: "USD", label: "US Dollar" },
  { code: "EUR", label: "Euro" },
  { code: "GBP", label: "British Pound" },
  { code: "INR", label: "Indian Rupee" },
  { code: "SAR", label: "Saudi Riyal" },
  { code: "PKR", label: "Pakistani Rupee" },
  { code: "PHP", label: "Philippine Peso" },
  { code: "EGP", label: "Egyptian Pound" },
] as const;

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]["code"];

interface RatesCache {
  rates: Record<string, number>;
  fetchedAt: number;
}

let cache: RatesCache | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // rates move slowly — an hour is plenty fresh

// Rates are AED -> other currency (e.g. rates.USD = 0.27 means 1 AED = 0.27 USD).
export async function fetchAedRates(): Promise<Record<string, number>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/AED", { cache: "no-store" });
    if (!res.ok) throw new Error("rate fetch failed");
    const data = await res.json();
    if (data.result !== "success" || !data.rates) throw new Error("bad rate response");
    cache = { rates: data.rates, fetchedAt: Date.now() };
    return cache.rates;
  } catch {
    // Offline / API down — fall back to the last known good rates if any,
    // otherwise just AED itself (1:1) so amounts still render, unconverted.
    return cache?.rates ?? { AED: 1 };
  }
}

export function convertFromAed(amountAed: number, currency: string, rates: Record<string, number>): number {
  const rate = rates[currency];
  if (!rate) return amountAed;
  return amountAed * rate;
}

const CURRENCY_FORMATTERS: Record<string, Intl.NumberFormat> = {};
function formatterFor(currency: string): Intl.NumberFormat {
  if (!CURRENCY_FORMATTERS[currency]) {
    try {
      CURRENCY_FORMATTERS[currency] = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    } catch {
      CURRENCY_FORMATTERS[currency] = new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    }
  }
  return CURRENCY_FORMATTERS[currency];
}

export function formatInCurrency(amountAed: number, currency: string, rates: Record<string, number>): string {
  if (currency === "AED" || !rates[currency]) {
    return `AED ${amountAed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return formatterFor(currency).format(convertFromAed(amountAed, currency, rates));
}
