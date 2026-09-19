"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

// Initials rather than a fixed letter — a signed-in person should see
// themselves in the corner, not the company monogram. Lives here beside the
// photo it stands in for, so the header and Settings cannot draw a different
// fallback from one another.
export function initialsOf(name: string, fallback: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback.slice(0, 1).toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const BUCKET = "avatars";
// The same key the phone builds (AccountSheet.swift) and the same one
// /api/account/avatar writes.
const avatarPath = (userId: string) => `user_${userId}.jpg`;

// Read exactly the way useBrandLogo reads the logo, and for the same reason:
// Storage's management "list" API needs a policy the anon key doesn't have
// here, so existence is established the way a browser would — a plain HEAD
// against the public object URL, with Last-Modified as the cache-buster so a
// fresh upload appears without a hard refresh. Anything other than a 200
// means this person has no photo, and their initials stand.
//
// Resolved once per user and shared: the header shows an avatar on every
// screen, and Settings shows the same one, so without this each mount would
// send its own request for an answer that cannot differ between them.
const resolved = new Map<string, Promise<string | null>>();
const listeners = new Map<string, Set<(url: string | null) => void>>();

function resolveAvatar(userId: string): Promise<string | null> {
  const cached = resolved.get(userId);
  if (cached) return cached;
  const supabase = supabaseBrowser();
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(avatarPath(userId));
  const pending = fetch(pub.publicUrl, { method: "HEAD", cache: "no-store" })
    .then((res) => {
      if (!res.ok) return null;
      const version = res.headers.get("last-modified") ?? res.headers.get("etag") ?? Date.now();
      return `${pub.publicUrl}?v=${encodeURIComponent(String(version))}`;
    })
    .catch(() => null);
  resolved.set(userId, pending);
  return pending;
}

/**
 * Re-read one person's photo and tell every screen showing it.
 *
 * Call after an upload. Without it the new photo only appears after a full
 * refresh: the header's image source was read when the page loaded.
 */
export function refreshAvatar(userId: string) {
  resolved.delete(userId);
  void resolveAvatar(userId).then((url) => {
    for (const notify of listeners.get(userId) ?? []) notify(url);
  });
}

export function useAvatar(userId: string) {
  const [url, setUrl] = useState<string | null>(null);
  // Distinguishes "no photo" from "haven't looked yet", so the fallback is
  // only drawn once we know there is nothing to draw instead of flashing
  // under a photo that is about to load.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    resolveAvatar(userId).then((next) => {
      if (cancelled) return;
      setUrl(next);
      setLoaded(true);
    });
    const notify = (next: string | null) => {
      if (!cancelled) setUrl(next);
    };
    let set = listeners.get(userId);
    if (!set) {
      set = new Set();
      listeners.set(userId, set);
    }
    set.add(notify);
    return () => {
      cancelled = true;
      set!.delete(notify);
    };
  }, [userId]);

  return { url, loaded };
}
