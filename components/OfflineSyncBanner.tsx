"use client";

import { useEffect, useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { flushPickQueue, hasQueuedPicks, isReachable } from "@/lib/offline-queue";
import { t } from "@/lib/i18n";

// While the banner says "Offline", re-probe this often so it clears on its
// own even if the browser never fires an "online" event.
const RECHECK_MS = 15_000;

// Mounted once at the app shell level so a queued pick survives navigation
// and syncs the moment connectivity returns, wherever the Warehouse user
// happens to be — not just while the specific order sheet is still open.
export default function OfflineSyncBanner() {
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let recheck: ReturnType<typeof setInterval> | null = null;
    setPending(hasQueuedPicks());

    async function trySync() {
      if (!hasQueuedPicks()) return;
      setSyncing(true);
      await flushPickQueue();
      if (cancelled) return;
      setPending(hasQueuedPicks());
      setSyncing(false);
    }

    // The browser's online flag is only a hint (see isReachable): trust it
    // when it says online, but confirm with a real request before showing
    // "Offline", and keep re-checking until we're reachable again.
    async function check() {
      const reachable = navigator.onLine || (await isReachable());
      if (cancelled) return;
      setOffline(!reachable);
      if (reachable) {
        if (recheck) {
          clearInterval(recheck);
          recheck = null;
        }
        trySync();
      } else if (!recheck) {
        recheck = setInterval(check, RECHECK_MS);
      }
    }

    function onVisible() {
      if (document.visibilityState === "visible") check();
    }

    window.addEventListener("online", check);
    window.addEventListener("offline", check);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    check();

    return () => {
      cancelled = true;
      if (recheck) clearInterval(recheck);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", check);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!offline && !pending && !syncing) return null;

  return (
    <div className="fixed bottom-16 md:bottom-4 start-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3.5 py-2 rounded-full bg-[--status-warning] text-white text-caption font-semibold shadow-lg">
      {offline ? (
        <>
          <WifiOff size={14} /> {t("app.offlinePicksWillSync")}
        </>
      ) : (
        <>
          <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> {t("app.syncingQueuedPicks")}
        </>
      )}
    </div>
  );
}
