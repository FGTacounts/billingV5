"use client";

import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { APPROVALS_DEFAULT, fetchApprovalSettings, type ApprovalSettings } from "@/lib/approvals";

// Which actions need a manager, for a screen that offers one of them.
//
// Starts from "everything needs approval" and only relaxes once the database
// has answered, so a slow read shows the cautious button rather than one the
// database might refuse.
export function useApprovalSettings(): ApprovalSettings {
  const [settings, setSettings] = useState<ApprovalSettings>(APPROVALS_DEFAULT);

  useEffect(() => {
    let cancelled = false;
    fetchApprovalSettings(supabaseBrowser()).then((next) => {
      if (!cancelled) setSettings(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return settings;
}
