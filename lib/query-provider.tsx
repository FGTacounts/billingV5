"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Required, not optional, per §0.2/§0.4 — "Performance as a design material":
// cache-then-revalidate pairs with skeleton screens, and useMutation gives
// mutations a place to hang optimistic updates (instant UI, reconcile in
// background, error toast only on real failure). staleTime is short since
// Realtime already pushes live invalidations for the tables that matter.
export default function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 15_000, refetchOnWindowFocus: false },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
