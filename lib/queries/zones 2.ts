import type { SupabaseClient } from "@supabase/supabase-js";

export interface Zone {
  id: string;
  name: string;
  vat_rate: number;
  currency_code: string;
  is_default: boolean;
}

export interface ZoneCountry {
  country_code: string;
  country_name: string;
  zone_id: string;
  currency_code: string | null;
}

// §Global: "The admin adds zones... all countries linked to that zone
// follow this... by default it is in one zone." Every read here degrades to
// an empty/default result rather than throwing when the zones migration
// (scratchpad/zones-and-payer-details-migration.sql) hasn't been run yet —
// same graceful-degradation pattern as every other optional-column feature
// in this app.
export async function fetchZones(supabase: SupabaseClient): Promise<Zone[]> {
  const { data, error } = await supabase.from("zones").select("id, name, vat_rate, currency_code, is_default").order("name");
  if (error) return [];
  return (data as Zone[]) ?? [];
}

export async function fetchZoneCountries(supabase: SupabaseClient): Promise<ZoneCountry[]> {
  const { data, error } = await supabase
    .from("zone_countries")
    .select("country_code, country_name, zone_id, currency_code")
    .order("country_name");
  if (error) return [];
  return (data as ZoneCountry[]) ?? [];
}

export async function createZone(
  supabase: SupabaseClient,
  input: { name: string; vat_rate: number; currency_code: string }
): Promise<void> {
  const { error } = await supabase.from("zones").insert(input);
  if (error) throw error;
}

export async function updateZone(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<Pick<Zone, "name" | "vat_rate" | "currency_code">>
): Promise<void> {
  const { error } = await supabase.from("zones").update(patch).eq("id", id);
  if (error) throw error;
}

// Setting a zone as default clears the previous default first — the
// zones_only_one_default partial unique index only allows one is_default
// row at a time, so a straight update would conflict.
export async function setDefaultZone(supabase: SupabaseClient, id: string): Promise<void> {
  const { error: clearErr } = await supabase.from("zones").update({ is_default: false }).eq("is_default", true);
  if (clearErr) throw clearErr;
  const { error } = await supabase.from("zones").update({ is_default: true }).eq("id", id);
  if (error) throw error;
}

export async function deleteZone(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from("zones").delete().eq("id", id);
  if (error) throw error;
}

export async function upsertZoneCountry(
  supabase: SupabaseClient,
  input: { country_code: string; country_name: string; zone_id: string; currency_code: string | null }
): Promise<void> {
  const { error } = await supabase.from("zone_countries").upsert(input, { onConflict: "country_code" });
  if (error) throw error;
}

export async function removeZoneCountry(supabase: SupabaseClient, countryCode: string): Promise<void> {
  const { error } = await supabase.from("zone_countries").delete().eq("country_code", countryCode);
  if (error) throw error;
}

// A customer's effective VAT rate: their country's zone, falling back to
// the Default zone, falling back to app_settings.vat_rate (pre-zones
// behavior) if the zones tables don't exist yet at all.
export async function resolveVatRate(
  supabase: SupabaseClient,
  countryCode: string | null | undefined,
  fallbackRate: number
): Promise<number> {
  const { data: zones, error: zonesErr } = await supabase.from("zones").select("id, vat_rate, is_default");
  if (zonesErr || !zones || zones.length === 0) return fallbackRate;

  if (countryCode) {
    const { data: zc } = await supabase
      .from("zone_countries")
      .select("zone_id")
      .eq("country_code", countryCode)
      .maybeSingle();
    if (zc?.zone_id) {
      const zone = zones.find((z) => z.id === zc.zone_id);
      if (zone) return zone.vat_rate;
    }
  }
  const defaultZone = zones.find((z) => z.is_default) ?? zones[0];
  return defaultZone?.vat_rate ?? fallbackRate;
}

// A customer's effective currency: their country's override, else their
// zone's currency, else 'AED'.
export async function resolveCurrency(
  supabase: SupabaseClient,
  countryCode: string | null | undefined
): Promise<string> {
  if (countryCode) {
    const { data: zc } = await supabase
      .from("zone_countries")
      .select("currency_code, zone_id")
      .eq("country_code", countryCode)
      .maybeSingle();
    if (zc?.currency_code) return zc.currency_code;
    if (zc?.zone_id) {
      const { data: zone } = await supabase.from("zones").select("currency_code").eq("id", zc.zone_id).maybeSingle();
      if (zone?.currency_code) return zone.currency_code;
    }
  }
  const { data: defaultZone } = await supabase.from("zones").select("currency_code").eq("is_default", true).maybeSingle();
  return defaultZone?.currency_code ?? "AED";
}
