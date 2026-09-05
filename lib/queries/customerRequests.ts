import type { SupabaseClient } from "@supabase/supabase-js";

// Customer changes raised by a salesman or the warehouse, waiting for a
// manager.
//
// They can type the change where they noticed it — standing in the shop, on
// the phone — but nothing reaches the shared record until a manager has looked
// at it. The alternative, letting everyone write directly, means one wrong
// area or credit note quietly changes what everybody else sees.

export interface CustomerChangeRequest {
  id: string;
  customer_id: string | null;
  payload: Record<string, unknown>;
  requested_by: string;
  requested_by_name?: string | null;
  customer_name?: string | null;
  status: "pending" | "approved" | "rejected";
  created_at: string;
}

// Remembered once, so a database without the table does not fail on every
// page load.
//
// PostgREST reports a missing table as PGRST205 from its schema cache and
// Postgres reports it as 42P01; which one arrives depends on whether the cache
// has been reloaded, so both count.
let tableMissing = false;

function isMissingTable(code?: string): boolean {
  return code === "42P01" || code === "PGRST205";
}

export function customerRequestsSupported(): boolean {
  return !tableMissing;
}

/** Raise a change for a manager to review. `customerId` null means a new customer. */
export async function requestCustomerChange(
  supabase: SupabaseClient,
  input: { customerId: string | null; payload: Record<string, unknown>; requestedBy: string }
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("customer_change_requests")
    .insert({
      customer_id: input.customerId,
      payload: input.payload,
      requested_by: input.requestedBy,
      status: "pending",
    })
    .select("id");
  if (error) {
    if (isMissingTable(error.code)) tableMissing = true;
    return { ok: false, error: error.message };
  }
  // A write the database declines is not an error — it changes nothing and
  // reports success — so an empty result is the only sign it did not apply.
  if (!data || data.length === 0) {
    return { ok: false, error: "That didn't send. Ask your administrator." };
  }
  return { ok: true };
}

/** Everything still waiting on a manager. */
export async function fetchPendingCustomerChanges(
  supabase: SupabaseClient
): Promise<CustomerChangeRequest[]> {
  if (tableMissing) return [];
  const { data, error } = await supabase
    .from("customer_change_requests")
    .select("id, customer_id, payload, requested_by, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false });
  if (error) {
    if (isMissingTable(error.code)) tableMissing = true;
    return [];
  }
  const rows = (data ?? []) as CustomerChangeRequest[];
  if (rows.length === 0) return rows;

  // Names, so the manager reads "Shamseer wants to change YAS MART" rather
  // than two identifiers.
  const [{ data: people }, { data: customers }] = await Promise.all([
    supabase.from("users").select("id, full_name").in("id", [...new Set(rows.map((r) => r.requested_by))]),
    supabase
      .from("customers")
      .select("id, name")
      .in("id", [...new Set(rows.map((r) => r.customer_id).filter((id): id is string => Boolean(id)))]),
  ]);
  const nameById = new Map((people ?? []).map((p) => [p.id, p.full_name]));
  const customerById = new Map((customers ?? []).map((c) => [c.id, c.name]));
  return rows.map((r) => ({
    ...r,
    requested_by_name: nameById.get(r.requested_by) ?? null,
    customer_name: r.customer_id ? customerById.get(r.customer_id) ?? null : null,
  }));
}

/**
 * Apply a request, then mark it approved.
 *
 * In that order deliberately: if writing the customer fails, the request stays
 * pending and can be tried again, rather than being marked done having changed
 * nothing.
 */
export async function approveCustomerChange(
  supabase: SupabaseClient,
  request: CustomerChangeRequest,
  reviewerId: string
): Promise<{ ok: boolean; error?: string }> {
  if (request.customer_id) {
    const { data, error } = await supabase
      .from("customers")
      .update(request.payload)
      .eq("id", request.customer_id)
      .select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) {
      return { ok: false, error: "Couldn't update that customer." };
    }
  } else {
    const { data, error } = await supabase.from("customers").insert(request.payload).select("id");
    if (error) return { ok: false, error: error.message };
    if (!data || data.length === 0) {
      return { ok: false, error: "Couldn't create that customer." };
    }
  }

  const { error: markErr } = await supabase
    .from("customer_change_requests")
    .update({ status: "approved", reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq("id", request.id);
  if (markErr) return { ok: false, error: markErr.message };
  return { ok: true };
}

export async function rejectCustomerChange(
  supabase: SupabaseClient,
  requestId: string,
  reviewerId: string
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("customer_change_requests")
    .update({ status: "rejected", reviewed_by: reviewerId, reviewed_at: new Date().toISOString() })
    .eq("id", requestId)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return { ok: false, error: "You don't have permission to review these." };
  }
  return { ok: true };
}
