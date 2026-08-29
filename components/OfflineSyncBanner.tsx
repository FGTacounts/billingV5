"use client";

import { useEffect, useState } from "react";
import { WifiOff, RefreshCw } from "lucide-react";
import { flushPickQueue, hasQueuedPicks } from "@/lib/offline-queue";

// Mounted once at the app shell level so a queued pick survives navigation
// and syncs the moment connectivity returns, wherever the Warehouse user
// happens to be — not just while the specific order sheet is still open.
export default function OfflineSyncBanner() {
  const [offline, setOffline] = useState(false);
  const [pending, setPending] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    setOffline(!navigator.onLine);
    setPending(hasQueuedPicks());

    async function trySync() {
      if (!navigator.onLine || !hasQueuedPicks()) return;
      setSyncing(true);
      await flushPickQueue();
      setPending(hasQueuedPicks());
      setSyncing(false);
    }

    function onOnline() {
      setOffline(false);
      trySync();
    }
    function onOffline() {
      setOffline(true);
    }

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    trySync();

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  if (!offline && !pending && !syncing) return null;

  return (
    <div className="fixed bottom-16 md:bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3.5 py-2 rounded-full bg-[--status-warning] text-white text-caption font-semibold shadow-lg">
      {offline ? (
        <>
          <WifiOff size={14} /> Offline — picks will sync automatically
        </>
      ) : (
        <>
          <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> Syncing queued picks…
        </>
      )}
    </div>
  );
}
