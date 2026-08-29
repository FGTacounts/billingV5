import "server-only";
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

// Use in Server Components, Server Actions, and Route Handlers. Reads the
// session from the request's cookies (set by the browser client via
// @supabase/ssr) — RLS on every query runs as that authenticated user, never
// as service-role.
export function supabaseServer() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options: CookieOptions }[]
        ) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Called from a Server Component render — middleware refreshes
            // the session instead, so this is safe to ignore.
          }
        },
      },
    }
  );
}
