"use client";

import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchExtensionRequests, decideExtension, type ExtensionRequestRow } from "@/lib/queries/payments";
import type { AppUser } from "@/lib/types/db";
import { t } from "@/lib/i18n";
import Button from "@/components/ui/Button";
import { Pill } from "@/components/ui/Badge";

// Request status values are stored data; only the label on the pill is
// user-facing text.
const EXTENSION_STATUS_LABEL: Record<string, string> = {
  pending: t("payments.statusPending"),
  approved: t("payments.statusApproved"),
  rejected: t("payments.statusRejected"),
};

export default function ExtensionRequestsSection({ user }: { user: AppUser }) {
  const [rows, setRows] = useState<ExtensionRequestRow[] | null>(null);
  const isManager = (user.role === "manager" || user.role === "admin");

  const load = useCallback(async () => {
    setRows(await fetchExtensionRequests(supabaseBrowser()));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function decide(id: string, status: "approved" | "rejected") {
    await decideExtension(supabaseBrowser(), id, status, user.id);
    load();
  }

  if (!rows || rows.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-headline font-semibold mb-3">{t("payments.extensionRequests")}</h2>
      <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline">
        {rows.map((r) => (
          <div key={r.id} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <div className="text-subhead font-medium">
                {r.customerName ?? t("common.notSet")} {r.order?.invoice_number ? `· #${r.order.invoice_number}` : ""}
              </div>
              <div className="text-caption text-secondary">
                {r.reason} {t("payments.requestedBy")} {r.requester?.full_name ?? t("common.notSet")}
              </div>
            </div>
            {r.status === "pending" && isManager ? (
              <div className="flex gap-2 shrink-0">
                <Button tier="plain" onClick={() => decide(r.id, "rejected")}>{t("payments.deny")}</Button>
                <Button tier="tinted" onClick={() => decide(r.id, "approved")}>{t("payments.approve")}</Button>
              </div>
            ) : (
              <Pill tone={r.status === "approved" ? "accent" : r.status === "rejected" ? "danger" : "warning"}>
                {EXTENSION_STATUS_LABEL[r.status]}
              </Pill>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
