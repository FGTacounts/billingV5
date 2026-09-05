"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox as InboxIcon, FileEdit, RotateCcw } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchInboxItems, type InboxItem } from "@/lib/queries/inbox";
import type { AppUser } from "@/lib/types/db";
import { Card } from "@/components/ui/Card";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";
import { toast } from "@/lib/toast";
import {
  fetchPendingCustomerChanges,
  approveCustomerChange,
  rejectCustomerChange,
  type CustomerChangeRequest,
} from "@/lib/queries/customerRequests";

const ICON = { edit_request: FileEdit, grv: RotateCcw } as const;

export default function InboxView({ user }: { user: AppUser }) {
  const router = useRouter();
  const isManager = user.role === "manager" || user.role === "admin";
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Customer changes a salesman or the warehouse has raised. Only a manager
  // sees these, and only a manager can act on them.
  const [changes, setChanges] = useState<CustomerChangeRequest[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadChanges = useCallback(() => {
    if (!isManager) return;
    fetchPendingCustomerChanges(supabaseBrowser()).then(setChanges).catch(() => {});
  }, [isManager]);

  useEffect(() => {
    fetchInboxItems(supabaseBrowser(), { isManager }).then((rows) => {
      setItems(rows);
      setLoading(false);
    });
    loadChanges();
  }, [isManager, loadChanges]);

  async function review(request: CustomerChangeRequest, approve: boolean) {
    setBusyId(request.id);
    const supabase = supabaseBrowser();
    const result = approve
      ? await approveCustomerChange(supabase, request, user.id)
      : await rejectCustomerChange(supabase, request.id, user.id);
    setBusyId(null);
    if (!result.ok) {
      toast.error(result.error ?? "That didn't go through.");
      return;
    }
    toast.success(approve ? "Applied." : "Turned down.");
    loadChanges();
  }

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <h1 className="text-large-title font-bold mb-5">Inbox</h1>

      {isManager && changes.length > 0 && (
        <div className="mb-6">
          <h2 className="text-title font-bold mb-3">Customer changes to review</h2>
          <div className="flex flex-col gap-2">
            {changes.map((c) => {
              const fields = Object.entries(c.payload).filter(
                ([, v]) => v !== null && v !== undefined && v !== ""
              );
              return (
                <div key={c.id} className="p-4 rounded-card border border-hairline bg-surface">
                  <div className="text-subhead font-semibold">
                    {c.customer_id
                      ? `${c.requested_by_name ?? "Someone"} wants to change ${c.customer_name ?? "a customer"}`
                      : `${c.requested_by_name ?? "Someone"} suggested a new customer`}
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
                      Apply
                    </button>
                    <button
                      disabled={busyId === c.id}
                      onClick={() => review(c, false)}
                      className="px-3 py-1.5 rounded-card border border-hairline text-caption font-semibold text-secondary hover:text-primary disabled:opacity-50"
                    >
                      Turn down
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <SkeletonList rows={4} />
      ) : items.length === 0 && changes.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={isManager ? "Nothing needs your attention — edit requests and pending returns show up here." : "Nothing needs your attention"}
        />
      ) : (
        <Card className="divide-y divide-hairline overflow-hidden">
          {items.map((item) => {
            const Icon = ICON[item.kind];
            return (
              <button
                key={item.id}
                onClick={() => router.push(item.href)}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
              >
                <div className="w-9 h-9 rounded-full bg-accent/12 text-accent grid place-items-center shrink-0">
                  <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-subhead font-semibold truncate">{item.title}</div>
                  <div className="text-caption text-secondary truncate">{item.subtitle}</div>
                </div>
                <div className="text-caption text-secondary shrink-0">
                  {new Date(item.createdAt).toLocaleDateString()}
                </div>
              </button>
            );
          })}
        </Card>
      )}
    </div>
  );
}
