import { NextRequest, NextResponse } from "next/server";
import { getAppUser } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { productFromRow, fetchProductsServer } from "@/lib/products-server";
import type { Product } from "@/lib/types/db";

export const runtime = "nodejs";

// Service-role-backed CRUD for `products`, replacing both the direct
// RLS-enforced client writes (broken — see below) and the products_safe
// view (removed from the live schema entirely; confirmed via PostgREST
// introspection). Two problems this sidesteps at once:
//  1. products_safe / order_items_safe used to null out cost/stock for
//     non-Manager sessions — no view now, so that masking has to happen in
//     the column list this route selects, based on the caller's real role.
//  2. RLS on the raw `products` table depends on current_role_is(), which
//     still references the old auth_id column (see the security-fix SQL
//     delivered earlier, not yet run) — any direct client write against
//     `products` fails today regardless of role. Routing through here
//     bypasses that broken RLS the same way every other write in this app
//     already does.
export async function GET(req: NextRequest) {
  const user = await getAppUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const products = await fetchProductsServer(supabaseAdmin(), {
      isManager: (user.role === "manager" || user.role === "admin"),
      activeOnly: req.nextUrl.searchParams.get("activeOnly") !== "false",
      search: req.nextUrl.searchParams.get("search") ?? undefined,
    });
    return NextResponse.json({ products });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load products" }, { status: 400 });
  }
}

function toDbPayload(input: Partial<Product> & { name?: string }) {
  const payload: Record<string, unknown> = {};
  if (input.name !== undefined) payload.description = input.name;
  if (input.sku !== undefined) payload.sku = input.sku;
  if (input.price !== undefined) payload.price = input.price;
  if (input.cost !== undefined) payload.cost = input.cost;
  if (input.default_qty !== undefined) payload.default_qty = input.default_qty;
  if (input.barcode !== undefined) payload.barcode = input.barcode;
  if (input.rack_location !== undefined) payload.rack_location = input.rack_location;
  if (input.is_active !== undefined) payload.is_active = input.is_active;
  // Stock on hand is never negative — a shelf holds nothing or something.
  if (input.stock_on_hand !== undefined) {
    payload.stock_on_hand =
      input.stock_on_hand == null ? null : Math.max(0, Math.round(Number(input.stock_on_hand) || 0));
  }
  if (input.category !== undefined) payload.Product_category = input.category;
  // Manager-entered overrides. Writing null is meaningful here — it's how you
  // clear an override and hand the figure back to the derived value — so
  // these check `!== undefined`, not truthiness.
  if (input.vac_override !== undefined) payload.vac_override = input.vac_override;
  if (input.vac_china_override !== undefined) payload.vac_china_override = input.vac_china_override;
  if (input.stock_arrival_date !== undefined) payload.stock_arrival_date = input.stock_arrival_date;
  if (input.stock_holding_days_override !== undefined) {
    payload.stock_holding_days_override = input.stock_holding_days_override;
  }
  return payload;
}

// Retries a write without the override columns when they don't exist yet
// (migration not run). Keeps the rest of the product editable in the
// meantime instead of failing the whole save.
const OVERRIDE_KEYS = [
  "vac_override",
  "vac_china_override",
  "stock_arrival_date",
  "stock_holding_days_override",
] as const;

function isMissingOverrideColumn(message: string): boolean {
  return OVERRIDE_KEYS.some((k) => message.includes(k));
}

function withoutOverrides(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...payload };
  for (const k of OVERRIDE_KEYS) delete copy[k];
  return copy;
}

export async function POST(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  const body = (await req.json()) as Partial<Product> & { name?: string };
  const payload = toDbPayload(body);
  const admin = supabaseAdmin();
  let { data, error } = await admin.from("products").insert(payload).select().single();
  let overridesDropped = false;
  if (error && isMissingOverrideColumn(error.message)) {
    overridesDropped = OVERRIDE_KEYS.some((k) => payload[k] != null);
    ({ data, error } = await admin.from("products").insert(withoutOverrides(payload)).select().single());
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ product: productFromRow(data), overridesDropped });
}

export async function PATCH(req: NextRequest) {
  const user = await getAppUser();
  if (!user || (user.role !== "manager" && user.role !== "admin")) {
    return NextResponse.json({ error: "Manager access required" }, { status: 403 });
  }
  const { id, ...rest } = (await req.json()) as Partial<Product> & { id: string; name?: string };
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
  const payload = toDbPayload(rest);
  const admin = supabaseAdmin();
  let { error } = await admin.from("products").update(payload).eq("id", id);
  let overridesDropped = false;
  if (error && isMissingOverrideColumn(error.message)) {
    overridesDropped = OVERRIDE_KEYS.some((k) => payload[k] != null);
    ({ error } = await admin.from("products").update(withoutOverrides(payload)).eq("id", id));
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  // Don't claim a clean save when the four Additional Details figures were
  // silently dropped because the migration hasn't been run — that's exactly
  // the "input that discards what you typed" this feature existed to avoid.
  return NextResponse.json({ ok: true, overridesDropped });
}
