"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";

const LOGO_PATH = "logo.png";
const DEFAULT_LOGO = "/brand/fgt-logo-transparent.png";

// The uploaded logo (§Global: "Users can upload their own logo. Syncs with
// all data") lives at one fixed path in the public "brand-assets" bucket.
// Storage's management "list" API needs a read policy the anon key doesn't
// have here, so existence/versioning is read the same way a browser would —
// a plain HEAD request against the public object URL, using its
// Last-Modified header to cache-bust so every tab picks up a fresh upload
// without a hard refresh. Falls back to the bundled default logo until an
// Admin uploads one (HEAD 400/404).
export function useBrandLogo() {
  const [url, setUrl] = useState(DEFAULT_LOGO);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const supabase = supabaseBrowser();
    const { data: pub } = supabase.storage.from("brand-assets").getPublicUrl(LOGO_PATH);
    fetch(pub.publicUrl, { method: "HEAD", cache: "no-store" })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          const version = res.headers.get("last-modified") ?? res.headers.get("etag") ?? Date.now();
          setUrl(`${pub.publicUrl}?v=${encodeURIComponent(version)}`);
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { url, loaded };
}
