"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Banknote, ImageIcon } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchPaymentsPage, confirmPayment, setChequeStatus, type PaymentRow, type PaymentCursor } from "@/lib/queries/payments";
import { notify } from "@/lib/queries/orders";
import { fetchPaymentsSummary, type PaymentsSummary } from "@/lib/queries/dashboard";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import type { AppUser, ChequeStatus } from "@/lib/types/db";
import { formatAed } from "@/lib/money";
import Button from "@/components/ui/Button";
import ExportLink from "@/components/ui/ExportLink";
import PageFooterActions from "@/components/ui/PageFooterActions";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import LogPaymentSheet from "./LogPaymentSheet";
import EditPaymentSheet from "./EditPaymentSheet";
import GrvSection from "./GrvSection";
import ExtensionRequestsSection from "./ExtensionRequestsSection";

// A payment counts as "edited" (§Payments: "shows as edited") once its
// updated_at has moved meaningfully past created_at — no schema change
// needed, both columns already exist and are DB-maintained. A few seconds
// of slack absorbs trigger/clock jitter at insert time.
function wasEdited(p: PaymentRow): boolean {
  return new Date(p.updated_at).getTime() - new Date(p.created_at).getTime() > 5000;
}

export default function PaymentsView({ user }: { user: AppUser }) {
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [cursor, setCursor] = useState<PaymentCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [mineOnly, setMineOnly] = useState((user.role !== "manager" && user.role !== "admin"));
  const [summary, setSummary] = useState<PaymentsSummary>({ pendingCount: 0, received: 0, overdue: 0, remaining: 0 });

  const isManager = (user.role === "manager" || user.role === "admin");

  // Salesman/Warehouse default to "only what I collected" (§7); Manager
  // always sees everyone's, with an optional toggle to narrow to their own.
  // Real cursor pagination (§0.4/§0.7) — resets to page 1 on filter change
  // or a Realtime event, "Load more" walks the cursor forward from there.
  const load = useCallback(async () => {
    setLoading(true);
    const supabase = supabaseBrowser();
    const [page, s] = await Promise.all([
      fetchPaymentsPage(supabase, { collectedBy: mineOnly ? user.id : undefined }),
      fetchPaymentsSummary(supabase, mineOnly ? { collectedBy: user.id } : {}),
    ]);
    setPayments(page.rows);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setSummary(s);
    setLoading(false);
  }, [mineOnly, user.id]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    const supabase = supabaseBrowser();
    const page = await fetchPaymentsPage(supabase, { collectedBy: mineOnly ? user.id : undefined, cursor });
    setPayments((prev) => [...prev, ...page.rows]);
    setCursor(page.nextCursor);
    setHasMore(page.nextCursor !== null);
    setLoadingMore(false);
  }

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeTable("payments", () => load());

  async function confirm(id: string) {
    const supabase = supabaseBrowser();
    await confirmPayment(supabase, id);
    load();
  }

  async function updateCheque(id: string, status: ChequeStatus) {
    const supabase = supabaseBrowser();
    await setChequeStatus(supabase, id, status);
    load();
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between mb-5 gap-3 flex-wrap">
        <h1 className="text-large-title font-bold">Payments</h1>
        <div className="flex items-center gap-4">
          {isManager && (
            <button
              onClick={() => setMineOnly((v) => !v)}
              className={`px-3 py-1.5 rounded-card text-caption font-semibold border ${
                mineOnly ? "bg-accent text-white border-accent" : "border-hairline text-secondary"
              }`}
            >
              Mine only
            </button>
          )}
          <Button tier="primary" onClick={() => setShowLog(true)} className="flex items-center gap-1.5">
            <Plus size={16} /> Log payment
          </Button>
        </div>
      </div>

      {!loading && (
        <div className="grid grid-cols-3 gap-3 mb-5">
          <Card className="p-4 text-center">
            <div className="text-caption text-secondary">Collected</div>
            <div className="text-title font-bold tabular-nums text-accent">{formatAed(summary.received)}</div>
          </Card>
          <Card className="p-4 text-center">
            <div className="text-caption text-secondary">Remaining</div>
            <div className="text-title font-bold tabular-nums">{formatAed(summary.remaining)}</div>
          </Card>
          <Card className="p-4 text-center">
            <div className="text-caption text-secondary">Overdue</div>
            <div className="text-title font-bold tabular-nums text-[--status-danger]">{formatAed(summary.overdue)}</div>
          </Card>
        </div>
      )}

      {loading ? (
        <SkeletonList rows={5} />
      ) : payments.length === 0 ? (
        <EmptyState icon={Banknote} title="No payments logged yet" />
      ) : (
        <div className="bg-surface border border-hairline rounded-card divide-y divide-hairline mb-8">
          {payments.map((p) => {
            const canEdit = isManager || p.collector_id === user.id;
            return (
              <div
                key={p.id}
                onClick={() => canEdit && setEditing(p)}
                className={`px-4 py-3.5 flex items-center justify-between gap-3 flex-wrap ${
                  canEdit ? "cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.03]" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="text-subhead font-semibold flex items-center gap-1.5">
                    {p.customer?.name ?? "—"}
                    {wasEdited(p) && <Pill tone="warning">Edited</Pill>}
                  </div>
                  <div className="text-caption text-secondary">
                    {p.cheque_number ? `Cheque ${p.cheque_number}${p.cheque_bank ? ` · ${p.cheque_bank}` : ""}` : "Cash"}
                    {" · "}
                    {new Date(p.created_at).toLocaleDateString()}
                    {p.collector?.full_name ? ` · ${p.collector.full_name}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                  {p.cheque_photo_ref && (
                    <a href={p.cheque_photo_ref} target="_blank" rel="noreferrer" aria-label="View cheque photo">
                      <ImageIcon size={16} className="text-secondary" />
                    </a>
                  )}
                  <span className="text-subhead font-semibold tabular-nums">{formatAed(p.amount)}</span>
                  {p.cheque_status && (
                    <select
                      className="text-caption border border-hairline rounded-card px-2 py-1 bg-surface"
                      value={p.cheque_status}
                      onChange={(e) => updateCheque(p.id, e.target.value as ChequeStatus)}
                      disabled={!isManager}
                    >
                      {["pending", "cleared", "bounced", "returned"].map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  )}
                  {p.status === "pending" ? (
                    isManager ? (
                      <Button tier="tinted" onClick={() => confirm(p.id)}>Confirm</Button>
                    ) : (
                      <Pill tone="warning">Pending</Pill>
                    )
                  ) : (
                    <Pill tone="accent">Confirmed</Pill>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PageFooterActions>
        {isManager && <ExportLink type="payments" />}
      </PageFooterActions>

      {hasMore && (
        <div className="flex justify-center mb-8 -mt-4">
          <Button tier="tinted" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}

      <ExtensionRequestsSection user={user} />
      <GrvSection user={user} />

      {showLog && (
        <LogPaymentSheet
          user={user}
          onClose={() => setShowLog(false)}
          onSaved={() => {
            setShowLog(false);
            load();
          }}
        />
      )}

      {editing && (
        <EditPaymentSheet
          payment={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            // Manager is notified when the collector edits their own
            // payment afterward (§Payments) — a Manager editing their own
            // logged payment doesn't need to notify themselves.
            if (!isManager) {
              const supabase = supabaseBrowser();
              const { data: managers } = await supabase.from("users").select("id").in("role", ["manager", "admin"]);
              for (const m of managers ?? []) {
                await notify(
                  supabase,
                  m.id,
                  "payment_edited",
                  "Payment edited",
                  `${user.full_name} edited a payment for ${editing.customer?.name ?? "a customer"}`
                );
              }
            }
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
