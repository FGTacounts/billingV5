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

interface NewsPost {
  id: string;
  created_at: string;
  author: string;
  author_role: string;
  title: string;
  body: string;
}

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
    const supabase = supabaseBrowser();
    const { data } = await supabase
      .from("notifications")
      .select("id, user_id, type, title, body, is_read, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
    setItems((data as Notification[]) ?? []);
  }, [userId]);

  const loadNews = useCallback(async () => {
    try {
      const res = await fetch("/api/news");
      const data = await res.json();
      setNews(data.news ?? []);
      setNewsSupported(data.supported !== false);
    } catch {
      // The bell must still work when news cannot be read.
    }
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
              <span className="flex items-center gap-1">
                {isManager && newsSupported && (
                  <Button
                    tier="plain"
                    onClick={() => setComposing(true)}
                    className="!px-2 !py-1 text-caption"
                  >
                    Post news
                  </Button>
                )}
                {items.length > 0 && (
                  <Button tier="plain" onClick={clearAll} className="!px-2 !py-1 text-caption">
                    Clear
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
                  <div className="font-medium text-primary">{n.title || "Team news"}</div>
                  {isManager && (
                    <button
                      onClick={async () => {
                        await fetch(`/api/news?id=${n.id}`, { method: "DELETE" });
                        loadNews();
                      }}
                      className="text-caption text-secondary hover:text-[--status-danger] shrink-0"
                    >
                      Remove
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
      if (!res.ok) throw new Error(data.error ?? "Couldn't post that");
      toast.success("Posted to the team.");
      onPosted();
    } catch (e) {
      toast.error(friendlyError(e, "Couldn't post that"));
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={onClose}
      title="Post news"
      footer={
        <>
          <Button tier="plain" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button tier="primary" onClick={post} disabled={saving || !body.trim()}>
            {saving ? "Posting…" : "Post to everyone"}
          </Button>
        </>
      }
    >
      <Label>Title (optional)</Label>
      <TextInput value={title} onChange={(e) => setTitle(e.target.value)} />
      <Label>Message</Label>
      <textarea
        className="w-full px-3.5 py-2.5 rounded-card border border-hairline bg-surface text-subhead outline-none focus:border-accent min-h-[100px]"
        placeholder="Everyone signed in will see this."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
    </Sheet>
  );
}
