import type { SupabaseClient } from "@supabase/supabase-js";
import type { Notification } from "@/lib/types/db";
import { t } from "@/lib/i18n";

// The Inbox (§Next Updates: "carries requests and permissions... from other
// users") is scoped to what the schema can actually back today — orders
// waiting on an edit-request decision and GRVs waiting on approval, both
// Manager-only concerns. There's no messages/permission-request table yet,
// so this surfaces real pending-decision items rather than fabricating a
// generic inbox.
export interface InboxItem {
  id: string;
  /** The order's or the return's own id, which is what approving it needs. */
  refId: string;
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
      refId: o.id,
      kind: "edit_request",
      title: `${t("inbox.editRequest")}${o.invoice_number ? ` · ${t("inbox.invoiceNumber", { number: o.invoice_number })}` : ""}`,
      subtitle: o.customer_id ? nameById.get(o.customer_id) ?? t("inbox.unknownCustomer") : t("inbox.unknownCustomer"),
      createdAt: o.updated_at ?? o.created_at,
      href: `/orders?open=${o.id}`,
    });
  }
  for (const g of grvs ?? []) {
    items.push({
      id: `grv-${g.id}`,
      refId: g.id,
      kind: "grv",
      title: t("inbox.goodsReturnAwaitingApproval"),
      subtitle: g.customer_id ? nameById.get(g.customer_id) ?? t("inbox.unknownCustomer") : t("inbox.unknownCustomer"),
      createdAt: g.created_at,
      href: `/payments`,
    });
  }

  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return items;
}

// ---------------------------------------------------------------------------
// The notification feed and team news.
//
// The bell in the header and the Inbox page show the same two lists, so the
// reads and the mark-as-read write live here once rather than being written
// twice and drifting apart. Anything that changes here changes in both places.

/** A notice a manager wrote once for the whole team (`news_posts`). */
export interface NewsPost {
  id: string;
  created_at: string;
  author: string;
  author_role: string;
  title: string;
  body: string;
}

/** This person's own notifications, newest first. */
export async function fetchNotifications(
  supabase: SupabaseClient,
  userId: string
): Promise<Notification[]> {
  const { data } = await supabase
    .from("notifications")
    .select("id, user_id, type, title, body, is_read, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);
  return (data as Notification[]) ?? [];
}

/**
 * Marks every unread notification of this person's as read.
 *
 * RLS grants this user UPDATE on their own rows only, so the filter is both
 * the scope and the guard.
 */
export async function markNotificationsRead(
  supabase: SupabaseClient,
  userId: string
): Promise<{ ok: boolean; error?: string }> {
  const { error } = await supabase
    .from("notifications")
    .update({ is_read: true })
    .eq("user_id", userId)
    .eq("is_read", false);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * Team news, through the route that reads it server-side.
 *
 * `supported` is false where the database has no `news_posts` table yet.
 * Returns null when the request itself could not be made, which callers treat
 * as "leave what is on screen alone" rather than as an empty feed.
 */
export async function fetchNewsPosts(): Promise<{ news: NewsPost[]; supported: boolean } | null> {
  try {
    const res = await fetch("/api/news");
    const data = await res.json();
    return { news: (data.news as NewsPost[]) ?? [], supported: data.supported !== false };
  } catch {
    return null;
  }
}
