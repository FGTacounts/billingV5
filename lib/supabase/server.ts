import "server-only";
import { cookies, headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
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

/**
 * The same thing, but for a route that may be called by the iOS app.
 *
 * `supabaseServer()` reads the session from cookies only. The phone sends a
 * Bearer token instead, so every cookie-only read ran as `anon` — which since
 * RUN-ME-13 can read nothing. That is why /api/product-photo answered
 * "product_photos_drive_folder_id is not set" for the app while the same row
 * was perfectly readable: the query was anonymous, not the setting missing.
 *
 * Still never service-role: the caller's own token is forwarded, so RLS runs
 * as that user exactly as it does for the browser.
 */
export function supabaseCaller() {
  const authorization = headers().get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) {
      return createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        }
      );
    }
  }
  return supabaseServer();
}
