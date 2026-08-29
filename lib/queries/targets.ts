import type { SupabaseClient } from "@supabase/supabase-js";

// Fallback used only when the database has nothing to say — i.e. before
// scratchpad/sales-targets-migration.sql has been run. Once it has, the
// company default lives in app_settings.default_monthly_target and each
// salesman can override it on their own row.
export const FALLBACK_MONTHLY_TARGET = 100000;

export interface MonthlyTargets {
  /** Per-salesman goal, for those who have one set. */
  byUser: Map<string, number>;
  /** Company-wide goal, used for anyone not in `byUser`. */
  fallback: number;
  /** Resolve the goal for one salesman. */
  forUser: (userId: string | undefined) => number;
}

function build(byUser: Map<string, number>, fallback: number): MonthlyTargets {
  return {
    byUser,
    fallback,
    forUser: (userId) => (userId && byUser.get(userId)) || fallback,
  };
}

/**
 * Every sales goal in the app. One fetch, shared by the Dashboard, the Sales
 * page and the salesman drill-down, so the same person can't be shown two
 * different goals on two screens.
 *
 * Degrades to the old constant if the columns don't exist yet, so the app
 * keeps working unchanged until the migration is run.
 */
// Remembered for the life of the page once we know the columns aren't there.
// Without this, every dashboard and Sales page load fires two requests that
// are guaranteed to fail, filling the browser console with errors and costing
// two round-trips for a result we already know.
let columnsMissing = false;

// The Dashboard, the Sales page, the drill-down and two widgets all ask for
// goals as they mount, within the same tick. `columnsMissing` is set from the
// reply, which has not arrived yet, so every one of them fires its own pair of
// requests — eleven failures in the console on a database without the columns,
// and six redundant round-trips on one with them. Sharing the promise means
// the first caller does the work and the rest wait on it.
let inFlight: Promise<MonthlyTargets> | null = null;

export function fetchMonthlyTargets(supabase: SupabaseClient): Promise<MonthlyTargets> {
  if (inFlight) return inFlight;
  inFlight = load(supabase).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function load(supabase: SupabaseClient): Promise<MonthlyTargets> {
  const byUser = new Map<string, number>();
  if (columnsMissing) return build(byUser, FALLBACK_MONTHLY_TARGET);

  const { data: settings, error: settingsErr } = await supabase
    .from("app_settings")
    .select("default_monthly_target")
    .limit(1)
    .maybeSingle();
  if (settingsErr) {
    columnsMissing = true;
    return build(byUser, FALLBACK_MONTHLY_TARGET);
  }
  const fallback =
    settings?.default_monthly_target != null
      ? Number(settings.default_monthly_target)
      : FALLBACK_MONTHLY_TARGET;

  const { data: users, error } = await supabase.from("users").select("id, monthly_target");
  if (error) {
    columnsMissing = true;
    return build(byUser, fallback);
  }
  for (const u of users ?? []) {
    if (u.monthly_target != null) byUser.set(u.id, Number(u.monthly_target));
  }
  return build(byUser, fallback);
}

/** Called after the migration is run so the app stops assuming it is absent. */
export function resetTargetsProbe() {
  columnsMissing = false;
  inFlight = null;
}

/** Sum of every listed salesman's individual goal — the team target. */
export function teamTarget(targets: MonthlyTargets, salesmanIds: string[]): number {
  return salesmanIds.reduce((sum, id) => sum + targets.forUser(id), 0);
}
