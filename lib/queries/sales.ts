import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCountedStatuses } from "@/lib/reportStage";
import { saleValue } from "@/lib/queries/dashboard";

export interface LeaderboardEntry {
  salesmanId: string;
  name: string;
  total: number;
}

function monthRangeIso(monthsAgo = 0): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - monthsAgo, 1);
  const end = new Date(now.getFullYear(), now.getMonth() - monthsAgo + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export async function fetchLeaderboard(
  supabase: SupabaseClient,
  monthsAgo = 0
): Promise<LeaderboardEntry[]> {
  const { start, end } = monthRangeIso(monthsAgo);
  const { data: salesmen, error: usersErr } = await supabase
    .from("users")
    .select("id, full_name")
    .eq("role", "salesman")
    .eq("is_active", true);
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

  return (salesmen ?? [])
    .map((s) => ({ salesmanId: s.id, name: s.full_name, total: totalsBySalesman.get(s.id) ?? 0 }))
    .sort((a, b) => b.total - a.total);
}
