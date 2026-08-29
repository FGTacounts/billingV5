"use client";

import { useEffect, useState } from "react";
import { usePreferences } from "@/lib/hooks/usePreferences";
import { fetchAedRates, formatInCurrency, type CurrencyCode } from "@/lib/currency";

// §Global: "Users can change the currency in the settings. (Prices change
// automatically according to latest currency prices)" — the preference
// lives in the same users.preferences JSON blob as every other per-user
// setting (theme, widget layout), so no new column was needed for this.
export function useDisplayCurrency() {
  const { preferences, update } = usePreferences();
  const currency = (preferences.displayCurrency as CurrencyCode | undefined) ?? "AED";
  const [rates, setRates] = useState<Record<string, number>>({ AED: 1 });

  useEffect(() => {
    if (currency === "AED") return;
    fetchAedRates().then(setRates);
  }, [currency]);

  function setCurrency(next: CurrencyCode) {
    update({ displayCurrency: next });
  }

  function format(amountAed: number): string {
    return formatInCurrency(amountAed, currency, rates);
  }

  return { currency, setCurrency, format };
}
