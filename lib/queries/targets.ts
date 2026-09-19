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
  /**
   * Per-salesman monthly bonus in AED, for those who have one set. The same
   * figure the phone keeps in GoalsStore.bonuses — AED, not minor units,
   * because it sits beside `monthly_target` and is added to it.
   *
   * There is no company-wide fallback for a bonus, unlike the goal: nobody
   * is owed a bonus by default, so "not set" means none rather than
   * "inherit the default".
   */
  bonusByUser: Map<string, number>;
  /** The manager's special-offer / incentive note, per salesman. */
  noteByUser: Map<string, string>;
  /** Resolve the bonus for one salesman. Null where none is set. */
  bonusForUser: (userId: string | undefined) => number | null;
  /** Resolve the incentive note for one salesman. Empty where none is set. */
  noteForUser: (userId: string | undefined) => string;
  /**
   * False until scratchpad/RUN-ME-20-salesman-bonus.sql has been run. The
   * editors hide themselves on that rather than offering a field that would
   * refuse every save.
   */
  bonusSupported: boolean;
}

function build(
  byUser: Map<string, number>,
  fallback: number,
  bonusByUser: Map<string, number> = new Map(),
  noteByUser: Map<string, string> = new Map(),
  bonusSupported = false
): MonthlyTargets {
  return {
    byUser,
    fallback,
    forUser: (userId) => (userId && byUser.get(userId)) || fallback,
    bonusByUser,
    noteByUser,
    bonusForUser: (userId) => (userId ? bonusByUser.get(userId) ?? null : null),
    noteForUser: (userId) => (userId ? noteByUser.get(userId) ?? "" : ""),
    bonusSupported,
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
// The same idea one migration later: `monthly_bonus` and `incentive_note`
// arrive with scratchpad/RUN-ME-20-salesman-bonus.sql, and a database
// without them must still hand back every goal. Tracked separately from
// `columnsMissing` because the two absences are independent — a database can
// have the goal columns and not these.
let bonusColumnsMissing = false;

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

  // Ask for all three, and if the two newer columns aren't there yet, ask
  // again without them — the same retry-without-the-new-columns shape
  // fetchProductsServer uses, so a database that is one migration behind
  // degrades to the goals it does have rather than to nothing at all.
  const BASE_COLS = "id, monthly_target";
  const BONUS_COLS = `${BASE_COLS}, monthly_bonus, incentive_note`;
  type UserRow = {
    id: string;
    monthly_target?: number | string | null;
    monthly_bonus?: number | string | null;
    incentive_note?: string | null;
  };

  let bonusSupported = !bonusColumnsMissing;
  let users: UserRow[] | null = null;

  if (bonusSupported) {
    const attempt = await supabase.from("users").select(BONUS_COLS);
    if (attempt.error) {
      bonusSupported = false;
    } else {
      users = (attempt.data ?? []) as UserRow[];
    }
  }

  if (!users) {
    const { data, error } = await supabase.from("users").select(BASE_COLS);
    if (error) {
      // Neither column set is there — the goals migration itself hasn't run.
      columnsMissing = true;
      return build(byUser, fallback);
    }
    // The base columns read fine, so what failed above was the new pair.
    if (!bonusSupported) bonusColumnsMissing = true;
    users = (data ?? []) as UserRow[];
  }

  const bonusByUser = new Map<string, number>();
  const noteByUser = new Map<string, string>();
  for (const u of users) {
    if (u.monthly_target != null) byUser.set(u.id, Number(u.monthly_target));
    if (u.monthly_bonus != null) bonusByUser.set(u.id, Number(u.monthly_bonus));
    const note = (u.incentive_note ?? "").trim();
    if (note) noteByUser.set(u.id, note);
  }
  return build(byUser, fallback, bonusByUser, noteByUser, bonusSupported);
}

/** Called after the migration is run so the app stops assuming it is absent. */
export function resetTargetsProbe() {
  columnsMissing = false;
  bonusColumnsMissing = false;
  inFlight = null;
}

/**
 * Write a salesman's bonus and/or incentive note.
 *
 * Shared by Settings › Users and the Sales page's Goal widget, which are the
 * two places a monthly goal is already set, so the two screens cannot drift
 * into saving it differently.
 *
 * Asks for the changed row back for the same reason `saveGoal` does: a write
 * the database declines to apply is not an error — it reports success and
 * changes nothing — so an empty result is the only way to tell "saved" from
 * "quietly refused". Returns false in that case; throws on a real error.
 */
export async function saveIncentive(
  supabase: SupabaseClient,
  userId: string,
  patch: { monthly_bonus?: number | null; incentive_note?: string | null }
): Promise<boolean> {
  const { data, error } = await supabase
    .from("users")
    .update(patch)
    .eq("id", userId)
    .select("id");
  if (error) throw error;
  const applied = !!data && data.length > 0;
  // The next read must see the new figure rather than the one cached from
  // before the write.
  if (applied) resetTargetsProbe();
  return applied;
}

/** Sum of every listed salesman's individual goal — the team target. */
export function teamTarget(targets: MonthlyTargets, salesmanIds: string[]): number {
  return salesmanIds.reduce((sum, id) => sum + targets.forUser(id), 0);
}
