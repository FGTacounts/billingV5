import type { SupabaseClient } from "@supabase/supabase-js";
import { t } from "@/lib/i18n";

// Which actions wait for a manager.
//
// Three things are raised as a request today: a customer change, the
// warehouse reopening an approved order, and a goods return. The admin decides
// in Settings which of them still need that, and every user follows the one
// answer.
//
// The switches are only ever a question the app asks. What a salesman or the
// warehouse may actually write is decided by the database
// (scratchpad/RUN-ME-26): switching a request off here and nothing else would
// leave them with a button the database refuses.
//
// Everything defaults to needing approval, and stays that way if the columns
// do not exist yet — a missing setting must never quietly remove a check
// people are relying on.
export interface ApprovalSettings {
  customerChanges: boolean;
  orderEdits: boolean;
  goodsReturns: boolean;
}

export type ApprovalKey = keyof ApprovalSettings;

export const APPROVALS_DEFAULT: ApprovalSettings = {
  customerChanges: true,
  orderEdits: true,
  goodsReturns: true,
};

const COLUMN: Record<ApprovalKey, string> = {
  customerChanges: "customer_changes_need_approval",
  orderEdits: "order_edits_need_approval",
  goodsReturns: "goods_returns_need_approval",
};

let columnsMissing = false;

/** False where the database has no switches yet (RUN-ME-26 not run). */
export function approvalSettingsSupported(): boolean {
  return !columnsMissing;
}

export async function fetchApprovalSettings(supabase: SupabaseClient): Promise<ApprovalSettings> {
  if (columnsMissing) return APPROVALS_DEFAULT;
  const { data, error } = await supabase
    .from("app_settings")
    .select(Object.values(COLUMN).join(", "))
    .limit(1)
    .maybeSingle();
  if (error) {
    // Remembered, so a pre-migration database does not fail this request on
    // every page load.
    columnsMissing = true;
    return APPROVALS_DEFAULT;
  }
  const row = (data ?? {}) as Record<string, boolean | null>;
  return {
    customerChanges: row[COLUMN.customerChanges] ?? true,
    orderEdits: row[COLUMN.orderEdits] ?? true,
    goodsReturns: row[COLUMN.goodsReturns] ?? true,
  };
}

/** Admin only — the database refuses anybody else, whatever the screen shows. */
export async function setApprovalNeeded(
  supabase: SupabaseClient,
  key: ApprovalKey,
  needed: boolean
): Promise<{ ok: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("app_settings")
    .update({ [COLUMN[key]]: needed })
    .eq("id", 1)
    .select("id");
  if (error) return { ok: false, error: error.message };
  // A write the database declines is not an error — it changes nothing and
  // reports success — so an empty result is the only sign it did not apply.
  if (!data || data.length === 0) {
    return { ok: false, error: t("documents.saveDeclined") };
  }
  return { ok: true };
}
