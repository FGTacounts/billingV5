"use client";

import { useEffect, useState, useCallback } from "react";
import { Bell } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { useRealtimeTable } from "@/lib/realtime/useRealtimeTable";
import { usePreferences } from "@/lib/hooks/usePreferences";
import type { Notification } from "@/lib/types/db";
import Button from "@/components/ui/Button";
import Sheet from "@/components/ui/Sheet";
import { Label, TextInput } from "@/components/ui/Field";
import { toast } from "@/lib/toast";
import { friendlyError } from "@/lib/errors";
import { t } from "@/lib/i18n";
// The same reads and the same mark-as-read write the Inbox page uses, so the
// bell and the page can never disagree about what has been seen.
import {
  fetchNotifications,
  fetchNewsPosts,
  markNotificationsRead,
  type NewsPost,
} from "@/lib/queries/inbox";

export default function NotificationsBell({
  userId,
  isManager = false,
}: {
  userId: string;
  isManager?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [news, setNews] = useState<NewsPost[]>([]);
  const [newsSupported, setNewsSupported] = useState(true);
  const [composing, setComposing] = useState(false);
  const { preferences } = usePreferences();
  const notificationsEnabled = preferences.notificationsEnabled !== false;
  // News is for everyone, so "new since you last looked" is per-browser —
  // there is no per-person read state on a shared announcement.
  const [newsSeen, setNewsSeen] = useState<number>(0);

  const load = useCallback(async () => {
    setItems(await fetchNotifications(supabaseBrowser(), userId));
  }, [userId]);

  const loadNews = useCallback(async () => {
    const result = await fetchNewsPosts();
    // The bell must still work when news cannot be read.
    if (!result) return;
    setNews(result.news);
    setNewsSupported(result.supported);
  }, []);

  useEffect(() => {
    load();
    loadNews();
    try {
      setNewsSeen(Number(localStorage.getItem(`fgt-news-seen-${userId}`) ?? 0));
    } catch {
      // A browser with storage blocked simply treats everything as new.
    }
  }, [load, loadNews, userId]);

  useRealtimeTable("notifications", () => load(), `user_id=eq.${userId}`);

  const unreadNews = news.filter((n) => +new Date(n.created_at) > newsSeen).length;
  const unread = notificationsEnabled
    ? items.filter((n) => !n.is_read).length + unreadNews
    : 0;

  async function markAllRead() {
    await markNotificationsRead(supabaseBrowser(), userId);
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
          if (!open) {
            if (items.some((n) => !n.is_read)) markAllRead();
            const now = Date.now();
            setNewsSeen(now);
            try {
              localStorage.setItem(`fgt-news-seen-${userId}`, String(now));
            } catch {
              // Storage blocked — the badge just comes back next time.
            }
          }
        }}
        className="relative w-9 h-9 grid place-items-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition"
        aria-label={t("inbox.notifications")}
      >
        <Bell size={19} className="text-primary" />
        {unread > 0 && (
          <span className="absolute top-1 end-1 min-w-[16px] h-4 px-1 rounded-full bg-[--status-danger] text-white text-[10px] font-bold grid place-items-center">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute end-0 top-11 z-50 w-80 max-h-96 overflow-y-auto rounded-card surface-panel shadow-floating">
            <div className="flex items-center justify-between px-4 py-3 border-b border-hairline">
              <span className="font-semibold text-headline">{t("inbox.notifications")}</span>
              <span className="flex items-center gap-1">
                {isManager && newsSupported && (
                  <Button
                    tier="plain"
                    onClick={() => setComposing(true)}
                    className="!px-2 !py-1 text-caption"
                  >
                    {t("inbox.postNews")}
                  </Button>
                )}
                {items.length > 0 && (
                  <Button tier="plain" onClick={clearAll} className="!px-2 !py-1 text-caption">
                    {t("inbox.clear")}
                  </Button>
                )}
              </span>
            </div>

            {/* Team news sits above the personal items: it is the thing
                everybody is meant to have read. */}
            {news.map((n) => (
              <div
                key={n.id}
                className="px-4 py-3 border-b border-hairline last:border-0 text-subhead bg-accent/[0.04]"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-medium text-primary">{n.title || t("inbox.teamNews")}</div>
                  {isManager && (
                    <button
                      onClick={async () => {
                        await fetch(`/api/news?id=${n.id}`, { method: "DELETE" });
                        loadNews();
                      }}
                      className="text-caption text-secondary hover:text-[--status-danger] shrink-0"
                    >
                      {t("common.remove")}
                    </button>
                  )}
                </div>
                <div className="text-caption text-secondary mt-0.5 whitespace-pre-wrap">{n.body}</div>
                <div className="text-caption text-secondary mt-0.5">
                  {n.author} · {new Date(n.created_at).toLocaleString()}
                </div>
              </div>
            ))}

            {items.length === 0 && news.length === 0 ? (
              <div className="px-4 py-8 text-center text-secondary text-subhead">
                {t("inbox.nothingYet")}
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

      {composing && (
        <ComposeNews
          onClose={() => setComposing(false)}
          onPosted={() => {
            setComposing(false);
            loadNews();
          }}
        />
      )}
    </div>
  );
}

// A manager writing to the whole team.
function ComposeNews({ onClose, onPosted }: { onClose: () => void; onPosted: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function post() {
    setSaving(true);
    try {
      const res = await fetch("/api/news", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? t("inbox.couldntPost"));
      toast.success(t("inbox.postedToTheTeam"));
      onPosted();
    } catch (e) {
      toast.error(friendlyError(e, t("inbox.couldntPost")));
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title={t("inbox.postNews")}
      footer={
        <>
          <Button tier="plain" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button tier="primary" onClick={post} disabled={saving || !body.trim()}>
            {saving ? t("inbox.posting") : t("inbox.postToEveryone")}
          </Button>
        </>
      }
    >
      <Label>{t("inbox.titleOptional")}</Label>
      <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
      <Label>{t("inbox.message")}</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[100px]"
        placeholder={t("inbox.newsBodyPlaceholder")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </Sheet>
  );
}
