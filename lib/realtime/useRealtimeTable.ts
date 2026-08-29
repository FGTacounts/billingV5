"use client";

import { useEffect } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";

// Subscribes to Postgres changes on `table` and invokes `onChange` for every
// insert/update/delete. Callers own the local state update (usually a
// react-query invalidate or optimistic patch) — this hook is just the wire.
export function useRealtimeTable(
  table: string,
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
  filter?: string
) {
  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`realtime:${table}:${filter ?? "all"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter },
        onChange
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, filter]);
}
