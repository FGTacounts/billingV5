import type { SupabaseClient } from "@supabase/supabase-js";

// The Inbox (§Next Updates: "carries requests and permissions... from other
// users") is scoped to what the schema can actually back today — orders
// waiting on an edit-request decision and GRVs waiting on approval, both
// Manager-only concerns. There's no messages/permission-request table yet,
// so this surfaces real pending-decision items rather than fabricating a
// generic inbox.
export interface InboxItem {
  id: string;
  kind: "edit_request" | "grv";
  title: string;
  subtitle: string;
  createdAt: string;
  href: string;
}

export async function fetchInboxItems(
  supabase: SupabaseClient,
  opts: { isManager: boolean }
): Promise<InboxItem[]> {
  if (!opts.isManager) return [];

  const [{ data: orders }, { data: grvs }] = await Promise.all([
    supabase
      .from("orders")
      .select("id, invoice_number, customer_id, created_at, updated_at")
      .eq("status", "edit_requested")
      .order("updated_at", { ascending: false }),
    supabase
      .from("grv_returns")
      .select("id, customer_id, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
  ]);

  const customerIds = [
    ...new Set([...(orders ?? []).map((o) => o.customer_id), ...(grvs ?? []).map((g) => g.customer_id)].filter(Boolean)),
  ] as string[];
  const { data: customers } = customerIds.length
    ? await supabase.from("customers").select("id, name").in("id", customerIds)
    : { data: [] as { id: string; name: string }[] };
  const nameById = new Map((customers ?? []).map((c) => [c.id, c.name]));

  const items: InboxItem[] = [];
  for (const o of orders ?? []) {
    items.push({
      id: `order-${o.id}`,
      kind: "edit_request",
      title: `Edit request${o.invoice_number ? ` · Invoice #${o.invoice_number}` : ""}`,
      subtitle: o.customer_id ? nameById.get(o.customer_id) ?? "Unknown customer" : "Unknown customer",
      createdAt: o.updated_at ?? o.created_at,
      href: `/orders?open=${o.id}`,
    });
  }
  for (const g of grvs ?? []) {
    items.push({
      id: `grv-${g.id}`,
      kind: "grv",
      title: "Goods return awaiting approval",
      subtitle: g.customer_id ? nameById.get(g.customer_id) ?? "Unknown customer" : "Unknown customer",
      createdAt: g.created_at,
      href: `/payments`,
    });
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return items;
}
