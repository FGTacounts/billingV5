import type { SupabaseClient } from "@supabase/supabase-js";
import type { Customer } from "@/lib/types/db";

const SELECT =
  "id, code, name, group_name, address, phone, district, vat_number, overdue_threshold_days, is_active, created_at, updated_at, salesman_id";

export async function fetchCustomers(
  supabase: SupabaseClient,
  opts: { search?: string } = {}
): Promise<Customer[]> {
  let q = supabase.from("customers").select(SELECT).eq("is_active", true).order("name");
  if (opts.search) {
    q = q.or(`name.ilike.%${opts.search}%,code.ilike.%${opts.search}%,group_name.ilike.%${opts.search}%`);
  }
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// country_code may not exist until scratchpad/zones-and-payer-details-migration.sql
// is run — retried without it rather than failing the whole save.
export async function createCustomer(supabase: SupabaseClient, input: Partial<Customer>) {
  const { error } = await supabase.from("customers").insert(input);
  if (error && input.country_code !== undefined) {
    const { country_code: _drop, ...rest } = input;
    const retry = await supabase.from("customers").insert(rest);
    if (retry.error) throw retry.error;
    return;
  }
  if (error) throw error;
}

export async function updateCustomer(
  supabase: SupabaseClient,
  id: string,
  input: Partial<Customer>
) {
  const { error } = await supabase.from("customers").update(input).eq("id", id);
  if (error && input.country_code !== undefined) {
    const { country_code: _drop, ...rest } = input;
    const retry = await supabase.from("customers").update(rest).eq("id", id);
    if (retry.error) throw retry.error;
    return;
  }
  if (error) throw error;
}

// Soft delete (is_active=false) rather than a hard DELETE — a customer
// with existing orders/payments can't be hard-deleted without breaking
// that financial history, and "Delete" in the Customer Detail screen means
// "remove from the active list," not "erase the record."
export async function deleteCustomer(supabase: SupabaseClient, id: string) {
  const { error } = await supabase.from("customers").update({ is_active: false }).eq("id", id);
  if (error) throw error;
}
