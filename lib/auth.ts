import "server-only";
import { supabaseServer } from "./supabase/server";
import type { AppUser } from "./types/db";

// The authenticated caller's `users` row (id, role, name, …), or null if not
// logged in, not yet provisioned a users row, or deactivated. Always read
// the role from here server-side — never trust a role the client claims.
export async function getAppUser(): Promise<AppUser | null> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, auth_user_id, username, full_name, role, email, is_active, created_at, updated_at")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !data || !data.is_active) return null;
  return data as AppUser;
}

// True if there's a live Supabase Auth session, regardless of whether it has
// a matching `users` row. Distinguishes "not logged in" from "logged in but
// no app profile" — the two need different handling (login form vs. a clear
// error) or a redirect loop happens: page-level code sends a profile-less
// session to /login, and middleware sends any authenticated session away
// from /login right back. See app/login/page.tsx.
export async function hasAuthSession(): Promise<boolean> {
  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return !!user;
}

export function landingPathFor(role: AppUser["role"]): string {
  if (role === "warehouse") return "/orders";
  return "/dashboard";
}
