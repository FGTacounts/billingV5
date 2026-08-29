import "server-only";
import { createClient } from "@supabase/supabase-js";

// Service-role client. NEVER import this from client components or expose
// its key as NEXT_PUBLIC_*. Only call from Route Handlers/Server Actions
// that have already re-verified the caller's session role is Manager.
export function supabaseAdmin() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set — admin actions are disabled."
    );
  }
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
