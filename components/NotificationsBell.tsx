"use client";

import { useEffect, useState, useCallback } from "react";
import { Bell } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import { usePreferences } from "@/lib/hooks/usePreferences";
import type { Notification } from "@/lib/types/db";
import Button from "@/components/ui/Button";

export default function NotificationsBell({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const { preferences } = usePreferences();
  const notificationsEnabled = preferences.notificationsEnabled !== false;

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data } = await supabase
      .from("notifications")
      .select("id, user_id, type, title, body, is_read, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
    setItems((data as Notification[]) ?? []);
  }, [userId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeTable("notifications", () => load(), `user_id=eq.${userId}`);

  const unread = notificationsEnabled ? items.filter((n) => !n.is_read).length : 0;

  async function markAllRead() {
    const supabase = supabaseBrowser();
    await supabase
      .from("notifications")
      .update({ is_read: true })
      .eq("user_id", userId)
      .eq("is_read", false);
    load();
  }

  // Notifications otherwise stay listed indefinitely (§Global: "should stay
  // in the small popup section until cleared") — this is the only way they
  // leave the panel. Routed server-side since RLS only grants this user
  // UPDATE/SELECT on their own notifications, not DELETE.
  async function clearAll() {
    await fetch("/api/notifications/clear", { method: "POST" });
    load();
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (!open && unread > 0) markAllRead();
        }}
        className="relative w-9 h-9 grid place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
        aria-label="Notifications"
      >
        <Bell size={19} className="text-primary" />
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-[--status-danger] text-white text-[10px] font-bold grid place-items-center">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-11 z-50 w-80 max-h-96 overflow-y-auto rounded-card surface-panel shadow-floating">
            <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
              <span className="font-semibold text-headline">Notifications</span>
              {items.length > 0 && (
                <Button tier="plain" onClick={clearAll} className="!px-2 !py-1 text-caption">
                  Clear
                </Button>
              )}
            </div>
            {items.length === 0 ? (
              <div className="px-4 py-8 text-center text-secondary text-subhead">
                Nothing yet
              </div>
            ) : (
              items.map((n) => (
                <div
                  key={n.id}
                  className="px-4 py-3 border-b border-hairline last:border-0 text-subhead"
                >
                  <div className={n.is_read ? "text-secondary" : "text-primary font-medium"}>
                    {n.title ?? n.type}
                  </div>
                  {n.body && (
                    <div className="text-caption text-secondary mt-0.5">{n.body}</div>
                  )}
                  <div className="text-caption text-secondary mt-0.5">
                    {new Date(n.created_at).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
