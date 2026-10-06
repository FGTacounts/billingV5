"use client";

import { useEffect, useRef } from "react";
import type { RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { supabaseBrowser } from "@/lib/supabase/client";

// Subscribes to Postgres changes on `table` and invokes `onChange` for every
// insert/update/delete. Callers own the local state update (usually a
// react-query invalidate or optimistic patch) — this hook is just the wire.
//
// An event always reaches the `onChange` from the latest render. The channel
// is only rebuilt when the table or filter changes, and it used to keep the
// handler it was built with — the page's reload as it was when the page
// opened. On Payments that reload had "only what I collected" baked in: turn
// the toggle and the list changed, then the next live payment reloaded it
// under the old setting. Reading through a ref keeps one channel per table
// and still runs today's handler.
export function useRealtimeTable(
  table: string,
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, unknown>>) => void,
  filter?: string
) {
  const latest = useRef(onChange);
  latest.current = onChange;

  useEffect(() => {
    const supabase = supabaseBrowser();
    const channel = supabase
      .channel(`realtime:${table}:${filter ?? "all"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter },
        (payload) => latest.current(payload)
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [table, filter]);
}
