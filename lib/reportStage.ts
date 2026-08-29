import type { SupabaseClient } from "@supabase/supabase-js";
import type { OrderStatus } from "@/lib/types/db";

// §Global: "Admin can adjust at what point of the order/payment flow orders
// affect reports." Everything used to be hardcoded to `status = delivered`.
//
// Only the post-approval stages are offered: before approval an order has no
// invoice number and hasn't been billed, so counting it as revenue would be
// wrong regardless of preference. Later stages imply the earlier ones — an
// order that's already delivered still counts when the setting is
// "approved".
export const REPORT_STAGE_OPTIONS = [
  {
    value: "approved" as const,
    label: "When approved",
    hint: "Counts as soon as the invoice is raised, before it ships.",
  },
  {
    value: "delivering" as const,
    label: "When out for delivery",
    hint: "Counts once it leaves the warehouse.",
  },
  {
    value: "delivered" as const,
    label: "When delivered",
    hint: "Counts only after the customer receives it. (Default)",
  },
];

export type ReportStage = (typeof REPORT_STAGE_OPTIONS)[number]["value"];

const STAGE_ORDER: ReportStage[] = ["approved", "delivering", "delivered"];
export const DEFAULT_REPORT_STAGE: ReportStage = "delivered";

// The statuses that count, given a threshold stage — the threshold itself
// plus everything downstream of it.
export function countedStatuses(stage: ReportStage): OrderStatus[] {
  const from = STAGE_ORDER.indexOf(stage);
  return STAGE_ORDER.slice(from < 0 ? STAGE_ORDER.length - 1 : from) as OrderStatus[];
}

let cached: { stage: ReportStage; at: number } | null = null;
let inFlight: Promise<ReportStage> | null = null;
const TTL_MS = 60_000;

// Degrades to the previous hardcoded behaviour ("delivered") if the column
// doesn't exist yet — see scratchpad/report-stage-migration.sql.
//
// A dashboard load calls this from ~6 queries at once. The TTL cache alone
// doesn't help there, because all six fire before any has resolved and so
// all six miss — hence the in-flight promise, which collapses a burst into
// a single request.
export async function fetchReportStage(supabase: SupabaseClient): Promise<ReportStage> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.stage;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const { data, error } = await supabase
      .from("app_settings")
      .select("reports_from_status")
      .limit(1)
      .maybeSingle();
    const value = !error && data?.reports_from_status;
    const stage = STAGE_ORDER.includes(value as ReportStage) ? (value as ReportStage) : DEFAULT_REPORT_STAGE;
    cached = { stage, at: Date.now() };
    return stage;
  })().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

export function invalidateReportStageCache() {
  cached = null;
  inFlight = null;
}

// Convenience: the statuses to filter on, in one call.
export async function fetchCountedStatuses(supabase: SupabaseClient): Promise<OrderStatus[]> {
  return countedStatuses(await fetchReportStage(supabase));
}
