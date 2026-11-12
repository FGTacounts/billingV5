import { t } from "@/lib/i18n";

// Stock held in other countries (RUN-ME-41). Managers only; the database
// refuses everyone else. See app/api/products/country-stock/route.ts.

export interface StockWarehouse {
  id: string;
  country: string;
  name: string;
}

export interface CountryStockRow {
  warehouse_id: string;
  country: string;
  name: string;
  qty: number;
}

export interface CountryStock {
  /** false until RUN-ME-41 has been run. */
  ready: boolean;
  rows: CountryStockRow[];
  warehouses: StockWarehouse[];
  /** The UAE figure (products.stock_on_hand) as the database has it now. */
  uae: number | null;
}

async function send(method: "GET" | "POST" | "DELETE", body?: unknown, query = ""): Promise<CountryStock> {
  const res = await fetch(`/api/products/country-stock${query}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? t("countryStock.failed"));
  return data as CountryStock;
}

export function fetchCountryStock(productId: string) {
  return send("GET", undefined, `?productId=${encodeURIComponent(productId)}`);
}

export function setCountryStock(
  productId: string,
  where: { warehouseId: string } | { country: string; name: string },
  qty: number
) {
  return send("POST", { action: "set", productId, qty, ...where });
}

export function removeCountryStock(productId: string, warehouseId: string) {
  return send("DELETE", { productId, warehouseId });
}

/** `null` is the UAE. */
export function moveStock(productId: string, from: string | null, to: string | null, qty: number) {
  return send("POST", { action: "move", productId, from, to, qty });
}

/** Every overseas warehouse, for choosing where an order's stock comes from. Empty until RUN-ME-41. */
export async function fetchStockWarehouses(): Promise<StockWarehouse[]> {
  const res = await fetch("/api/products/country-stock?warehouses=1");
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as { warehouses?: StockWarehouse[] };
  return data.warehouses ?? [];
}

/** Overseas total per product id, for the Products list. Empty until RUN-ME-41. */
export async function fetchOverseasTotals(): Promise<Map<string, number>> {
  const res = await fetch("/api/products/country-stock?totals=1");
  if (!res.ok) return new Map();
  const data = (await res.json().catch(() => ({}))) as { totals?: Record<string, number> };
  return new Map(Object.entries(data.totals ?? {}));
}
