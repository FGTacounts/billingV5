"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

const LOGO_PATH = "logo.png";
const DEFAULT_LOGO = "/brand/fgt-logo-transparent.png";

// The uploaded logo (§Global: "Users can upload their own logo. Syncs with
// all data") lives at one fixed path in the public "brand-assets" bucket.
// Storage's management "list" API needs a read policy the anon key doesn't
// have here, so existence is read the same way a browser would — a plain HEAD
// against the public object URL, using Last-Modified to cache-bust so a fresh
// upload is picked up without a hard refresh. A 400/404 means nobody has
// uploaded one, and the bundled default is used.
//
// Resolved once and shared. The header and the sidebar both ask as they mount,
// and every screen that shows the logo would otherwise send its own request
// for an answer that cannot differ between them.
let resolved: Promise<string> | null = null;
const listeners = new Set<(url: string) => void>();

function resolveLogo(): Promise<string> {
  if (resolved) return resolved;
  const supabase = supabaseBrowser();
  const { data: pub } = supabase.storage.from("brand-assets").getPublicUrl(LOGO_PATH);
  resolved = fetch(pub.publicUrl, { method: "HEAD", cache: "no-store" })
    .then((res) => {
      if (!res.ok) return DEFAULT_LOGO;
      const version = res.headers.get("last-modified") ?? res.headers.get("etag") ?? Date.now();
      return `${pub.publicUrl}?v=${encodeURIComponent(version)}`;
    })
    .catch(() => DEFAULT_LOGO);
  return resolved;
}

/**
 * Re-read the logo and tell every screen showing it.
 *
 * Call after an upload or a removal. Without this the new logo only appeared
 * after a full page refresh: the old code bumped a render key, but the image
 * source it re-rendered with was the one read when the page first loaded, so
 * the preview and the sidebar both kept showing the previous logo.
 */
export function refreshBrandLogo() {
  resolved = null;
  void resolveLogo().then((url) => {
    for (const notify of listeners) notify(url);
  });
}

export function useBrandLogo() {
  const [url, setUrl] = useState(DEFAULT_LOGO);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    resolveLogo().then((next) => {
      if (cancelled) return;
      setUrl(next);
      setLoaded(true);
    });
    const notify = (next: string) => {
      if (!cancelled) setUrl(next);
    };
    listeners.add(notify);
    return () => {
      cancelled = true;
      listeners.delete(notify);
    };
  }, []);

  return { url, loaded };
}
