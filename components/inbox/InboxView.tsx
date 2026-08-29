"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox as InboxIcon, FileEdit, RotateCcw } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { fetchInboxItems, type InboxItem } from "@/lib/queries/inbox";
import type { AppUser } from "@/lib/types/db";
import { Card } from "@/components/ui/Card";
import { EmptyState, SkeletonList } from "@/components/ui/Empty";

const ICON = { edit_request: FileEdit, grv: RotateCcw } as const;

export default function InboxView({ user }: { user: AppUser }) {
  const router = useRouter();
  const isManager = user.role === "manager" || user.role === "admin";
  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchInboxItems(supabaseBrowser(), { isManager }).then((rows) => {
      setItems(rows);
      setLoading(false);
    });
  }, [isManager]);

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <h1 className="text-large-title font-bold mb-5">Inbox</h1>

      {loading ? (
        <SkeletonList rows={4} />
      ) : items.length === 0 ? (
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
