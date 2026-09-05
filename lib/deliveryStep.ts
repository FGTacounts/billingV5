import type { SupabaseClient } from "@supabase/supabase-js";

// Whether the business uses a delivery step at all.
//
// Some operations hand the goods over at approval and never track a separate
// delivery; for them a Delivery tab is dead weight. The manager decides in
// Settings, and every user follows that one answer.
//
// Defaults to on, and stays on if the column does not exist yet — a missing
// setting should not silently remove a step people are relying on.
export const DELIVERY_STEP_DEFAULT = true;

let columnMissing = false;

export async function fetchDeliveryEnabled(supabase: SupabaseClient): Promise<boolean> {
  if (columnMissing) return DELIVERY_STEP_DEFAULT;
  const { data, error } = await supabase
    .from("app_settings")
    .select("delivery_enabled")
    .limit(1)
    .maybeSingle();
  if (error) {
    // Remembered, so a pre-migration database does not fail this request on
    // every page load.
    columnMissing = true;
    return DELIVERY_STEP_DEFAULT;
  }
  return (data?.delivery_enabled as boolean | null) ?? DELIVERY_STEP_DEFAULT;
}

export async function setDeliveryEnabled(
  supabase: SupabaseClient,
  enabled: boolean
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("app_settings")
    .update({ delivery_enabled: enabled })
    .eq("id", 1)
    .select("id");
  if (error) return { ok: false, error: error.message };
  // A write the database declines is not an error — it changes nothing and
  // reports success — so an empty result is the only sign it did not apply.
  if (!data || data.length === 0) {
    return { ok: false, error: "That didn't save. Ask your administrator." };
  }
  return { ok: true };
}
