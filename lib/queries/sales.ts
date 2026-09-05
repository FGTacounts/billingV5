import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "@/lib/types/db";
import { fetchCountedStatuses } from "@/lib/reportStage";
import { saleValue } from "@/lib/queries/dashboard";

export interface LeaderboardEntry {
  salesmanId: string;
  name: string;
  total: number;
  // The billing person's role, so a screen can say "(manager)" next to
  // someone who is not a salesman but did bill. Optional so older callers
  // that build an entry by hand still typecheck.
  role?: UserRole;
  isActive?: boolean;
}

export interface Seller {
  id: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}

function monthRangeIso(monthsAgo = 0): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Everyone who may be recorded as the person billing an order.
//
// It is not only the salesmen: a manager covering a route bills orders too
// (three of them on the live database when this was written), and their
// sale has to be attributable to a name like anyone else's. The list a
// screen offers to pick from and the list a sale can be attributed to are
// the same list — keeping them apart is how an order ends up billed by
// someone the Sales page cannot name.
export async function fetchSellers(supabase: SupabaseClient): Promise<Seller[]> {
  const { data, error } = await supabase
    .from("users")
    .select("id, full_name, role, is_active")
    .in("role", ["salesman", "manager", "admin"])
    .eq("is_active", true)
    .order("full_name");
  if (error) throw error;
  return (data ?? []).map((u) => ({
    id: u.id,
    name: u.full_name,
    role: u.role as UserRole,
    isActive: u.is_active as boolean,
  }));
}

export async function fetchLeaderboard(
  supabase: SupabaseClient,
  monthsAgo = 0
): Promise<LeaderboardEntry[]> {
  const { start, end } = monthRangeIso(monthsAgo);
  // Every user, not just the active salesmen: the totals below have to find
  // a name for whoever is on the order. Someone who has left still sold
  // what they sold, and a manager who bills is not invisible.
  const { data: users, error: usersErr } = await supabase
    .from("users")
    .select("id, full_name, role, is_active");
  if (usersErr) throw usersErr;

  const { data: orders, error } = await supabase
    .from("orders")
    .select("salesman_id, subtotal, total")
    .in("status", await fetchCountedStatuses(supabase))
    .gte("updated_at", start)
    .lt("updated_at", end);
  if (error) throw error;

  const totalsBySalesman = new Map<string, number>();
  for (const o of orders ?? []) {
    if (!o.salesman_id) continue;
    // Sale value excludes VAT — see saleValue() in queries/dashboard.
    totalsBySalesman.set(o.salesman_id, (totalsBySalesman.get(o.salesman_id) ?? 0) + saleValue(o));
  }

  const byId = new Map((users ?? []).map((u) => [u.id as string, u]));
  const entries: LeaderboardEntry[] = [];

  for (const u of users ?? []) {
    const total = totalsBySalesman.get(u.id as string) ?? 0;
    const isRosteredSalesman = u.role === "salesman" && u.is_active;
    // A rostered salesman is always on the board, at zero if need be —
    // that absence is itself the information. Anyone else appears only
    // once they have actually billed something.
    if (!isRosteredSalesman && total <= 0) continue;
    entries.push({
      salesmanId: u.id as string,
      name: u.full_name as string,
      total,
      role: u.role as UserRole,
      isActive: u.is_active as boolean,
    });
  }

  // A sale attributed to an id with no user row behind it any more. It is
  // still money, so it keeps its place under a name that says what it is
  // rather than being quietly dropped out of the totals.
  for (const [id, total] of totalsBySalesman) {
    if (byId.has(id) || total <= 0) continue;
    entries.push({ salesmanId: id, name: "Unknown user", total });
  }

  return entries.sort((a, b) => b.total - a.total);
}
