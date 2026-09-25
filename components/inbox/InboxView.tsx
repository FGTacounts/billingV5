"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox as InboxIcon, FileEdit, RotateCcw } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import {
  fetchInboxItems,
  fetchNotifications,
  fetchNewsPosts,
  markNotificationsRead,
  type InboxItem,
  type NewsPost,
} from "@/lib/queries/inbox";
import type { AppUser, Notification } from "@/lib/types/db";
import { Card } from "@/components/ui/Card";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { toast } from "@/lib/toast";
import { t } from "@/lib/i18n";
import {
  fetchPendingCustomerChanges,
  approveCustomerChange,
  rejectCustomerChange,
  type CustomerChangeRequest,
} from "@/lib/queries/customerRequests";
import { approveGrv } from "@/lib/queries/grv";

const ICON = { edit_request: FileEdit, grv: RotateCcw } as const;

// One place to see what needs doing, matching the phone's single screen: what
// is waiting on a decision at the top, then the notification feed and the
// team's news underneath. The bell in the header shows the same two feeds as
// a glance without leaving the page you are on.
export default function InboxView({ user }: { user: AppUser }) {
  const router = useRouter();
  const isManager = user.role === "manager" || user.role === "admin";
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Customer changes a salesman or the warehouse has raised. Only a manager
  // sees these, and only a manager can act on them.
  const [changes, setChanges] = useState<CustomerChangeRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The same two feeds the bell carries.
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [news, setNews] = useState<NewsPost[]>([]);

  const loadChanges = useCallback(() => {
    if (!isManager) return Promise.resolve();
    return fetchPendingCustomerChanges(supabaseBrowser()).then(setChanges).catch(() => {});
  }, [isManager]);

  // Reading the page is reading the notifications, which is exactly what the
  // bell does when it opens. Applied here first and rolled back if the write
  // does not land, so the list never claims something the database refused.
  const markFeedRead = useCallback(
    async (rows: Notification[]) => {
      if (!rows.some((n) => !n.is_read)) return;
      setNotifications(rows.map((n) => (n.is_read ? n : { ...n, is_read: true })));
      const result = await markNotificationsRead(supabaseBrowser(), user.id);
      if (!result.ok) {
        setNotifications(rows);
        toast.error(result.error ?? t("inbox.couldntMarkRead"));
      }
    },
    [user.id]
  );

  useEffect(() => {
    let cancelled = false;
    const supabase = supabaseBrowser();
    // Everything the page shows arrives together, so a section cannot appear
    // empty for a moment and then fill in under the reader's eyes.
    Promise.all([
      fetchInboxItems(supabase, { isManager }),
      fetchNotifications(supabase, user.id),
      fetchNewsPosts(),
      loadChanges(),
    ])
      .then(([rows, feed, newsResult]) => {
        if (cancelled) return;
        setItems(rows);
        setNotifications(feed);
        if (newsResult) setNews(newsResult.news);
        setLoading(false);
        void markFeedRead(feed);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isManager, loadChanges, markFeedRead, user.id]);

  async function review(request: CustomerChangeRequest, approve: boolean) {
    setBusyId(request.id);
    const supabase = supabaseBrowser();
    const result = approve
      ? await approveCustomerChange(supabase, request, user.id)
      : await rejectCustomerChange(supabase, request.id, user.id);
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error ?? t("inbox.didntGoThrough"));
      return;
    }
    toast.success(approve ? t("inbox.applied") : t("inbox.turnedDown"));
    loadChanges();
  }

  // Approving from the row, so a manager who came here from the notification
  // does not have to open the order or Payments first. The row goes at once
  // and comes back where it was if the approval does not land.
  async function approveItem(item: InboxItem) {
    const before = items;
    setItems(before.filter((i) => i.id !== item.id));
    try {
      if (item.kind === "edit_request") {
        const res = await fetch("/api/orders/grant-edit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: item.refId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? t("inbox.didntGoThrough"));
      } else {
        await approveGrv(supabaseBrowser(), item.refId, user.id);
      }
      toast.success(t("inbox.approved"));
    } catch (e) {
      setItems(before);
      toast.error(e instanceof Error && e.message ? e.message : t("inbox.didntGoThrough"));
    }
  }

  const needsAttention = changes.length > 0 || items.length > 0;
  const hasAnything = needsAttention || notifications.length > 0 || news.length > 0;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <h1 className="text-large-title font-bold mb-5">{t("nav.inbox")}</h1>

      {loading ? (
        <SkeletonList rows={6} />
      ) : !hasAnything ? (
        <EmptyState
          icon={InboxIcon}
          title={
            isManager
              ? t("inbox.emptyManager")
              : t("inbox.empty")
          }
        />
      ) : (
        <div className="flex flex-col gap-6">
          {needsAttention && (
            <section>
              <h2 className="text-title font-bold mb-3">{t("inbox.needsYourAttention")}</h2>
              <div className="flex flex-col gap-2">
                {changes.map((c) => {
                  const fields = Object.entries(c.payload).filter(
                    ([, v]) => v !== null && v !== undefined && v !== ""
                  );
                  return (
                    <div key={c.id} className="p-4 rounded-card border border-hairline bg-surface">
                      <div className="text-subhead font-semibold">
                        {c.customer_id
                          ? t("inbox.wantsToChange", {
                              who: c.requested_by_name ?? t("inbox.someone"),
                              customer: c.customer_name ?? t("inbox.aCustomer"),
                            })
                          : t("inbox.suggestedNewCustomer", { who: c.requested_by_name ?? t("inbox.someone") })}
                      </div>
                      <dl className="mt-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-caption">
                        {fields.map(([key, value]) => (
                          <Fragment key={key}>
                            <dt className="text-secondary capitalize">{key.replace(/_/g, " ")}</dt>
                            <dd className="truncate">{String(value)}</dd>
                          </Fragment>
                        ))}
                      </dl>
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          disabled={busyId === c.id}
                          onClick={() => review(c, true)}
                          className="px-3 py-1.5 rounded-card bg-accent text-white text-caption font-semibold disabled:opacity-50"
                        >
                          {t("inbox.apply")}
                        </button>
                        <button
                          disabled={busyId === c.id}
                          onClick={() => review(c, false)}
                          className="px-3 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-primary disabled:opacity-50"
                        >
                          {t("inbox.turnDown")}
                        </button>
                      </div>
                    </div>
                  );
                })}

                {items.length > 0 && (
                  <Card className="divide-y divide-hairline overflow-hidden">
                    {items.map((item) => {
                      const Icon = ICON[item.kind];
                      return (
                        <div key={item.id} className="flex items-center gap-3 pe-4">
                          <button
                            onClick={() => router.push(item.href)}
                            className="min-w-0 flex-1 flex items-center gap-3 ps-4 py-3.5 text-start hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
                          >
                            <div className="w-9 h-9 rounded-full bg-accent/12 text-accent grid place-items-center shrink-0">
                              <Icon size={16} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="text-subhead font-semibold truncate">{item.title}</div>
                              <div className="text-caption text-secondary truncate">{item.subtitle}</div>
                            </div>
                            <div className="text-caption text-secondary shrink-0 tabular-nums">
                              {new Date(item.createdAt).toLocaleDateString()}
                            </div>
                          </button>
                          <button
                            onClick={() => approveItem(item)}
                            className="shrink-0 px-3 py-1.5 rounded-card bg-accent text-white text-caption font-semibold"
                          >
                            {t("inbox.approve")}
                          </button>
                        </div>
                      );
                    })}
                  </Card>
                )}
              </div>
            </section>
          )}

          {/* Team news sits above the personal items, as it does in the bell:
              it is the thing everybody is meant to have read. */}
          {news.length > 0 && (
            <section>
              <h2 className="text-title font-bold mb-3">{t("inbox.teamNews")}</h2>
              <Card className="divide-y divide-hairline overflow-hidden">
                {news.map((n) => (
                  <div key={n.id} className="px-4 py-3 text-subhead bg-accent/[0.04]">
                    <div className="font-medium text-primary">{n.title || t("inbox.teamNews")}</div>
                    <div className="text-caption text-secondary mt-0.5 whitespace-pre-wrap">
                      {n.body}
                    </div>
                    <div className="text-caption text-secondary mt-0.5">
                      {n.author} ·{" "}
                      <span className="tabular-nums">
                        {new Date(n.created_at).toLocaleString()}
                      </span>
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          )}

          {notifications.length > 0 && (
            <section>
              <h2 className="text-title font-bold mb-3">{t("inbox.notifications")}</h2>
              <Card className="divide-y divide-hairline overflow-hidden">
                {notifications.map((n) => (
                  <div key={n.id} className="px-4 py-3 text-subhead">
                    <div className={n.is_read ? "text-secondary" : "text-primary font-medium"}>
                      {n.title ?? n.type}
                    </div>
                    {n.body && <div className="text-caption text-secondary mt-0.5">{n.body}</div>}
                    <div className="text-caption text-secondary mt-0.5 tabular-nums">
                      {new Date(n.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </Card>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
