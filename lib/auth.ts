import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { supabaseServer } from "./supabase/server";
import type { AppUser } from "./types/db";

const USER_COLUMNS =
  "id, auth_user_id, username, full_name, role, email, is_active, created_at, updated_at";

/**
 * The signed-in caller, whether they arrived from the web app or a phone.
 *
 * The browser keeps its session in a cookie, which is all this used to read.
 * A native app has no cookie — it holds a token and sends it in the
 * Authorization header — so every request from the iOS app looked
 * unauthenticated, and creating a user came back "Manager access required"
 * however the manager signed in.
 *
 * The token is verified by Supabase, not merely decoded here, and the users
 * row is then read through a client carrying that same token, so the row
 * rules apply exactly as they do for the web. A forged or expired token
 * yields null, the same as no token at all.
 */
/**
 * Which door an admin came in by (owner, 2026-11-27: "if bilal … selects
 * warehouse and then signs in, he will have access to the account as a
 * warehouse user; if he signs in in the salesman's page, he is treated as a
 * salesman; and if he signs in through the manager, he is treated as an
 * admin").
 *
 * The sign-in form leaves the door in the `fgt-act-as` cookie; the iPhone,
 * iPad and Mac app send it as an `X-Act-As` header. Only ever a step DOWN,
 * and only for an account the database says is an admin: anybody else's
 * claim is ignored, so nobody can talk their way up. Row rules (RLS) still
 * see the real admin — this decides what the app shows and allows.
 */
export const ACT_AS_COOKIE = "fgt-act-as";
const ACT_AS_ROLES = ["salesman", "warehouse"] as const;

function actingAs(user: AppUser, requested: string | null | undefined): AppUser {
  if (user.role !== "admin" || !requested) return user;
  const role = requested.toLowerCase();
  return (ACT_AS_ROLES as readonly string[]).includes(role) ? { ...user, role: role as AppUser["role"] } : user;
}

async function callerFromBearerToken(): Promise<AppUser | null> {
  const authorization = headers().get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token) return null;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const {
    data: { user },
  } = await asCaller.auth.getUser(token);
  if (!user) return null;

  const { data, error } = await asCaller
    .from("users")
    .select(USER_COLUMNS)
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !data || !data.is_active) return null;
  return actingAs(data as AppUser, headers().get("x-act-as"));
}

// The authenticated caller's `users` row (id, role, name, …), or null if not
// logged in, not yet provisioned a users row, or deactivated. Always read
// the role from here server-side — never trust a role the client claims.
//
// Wrapped in React's per-request cache: opening a page runs the (app) layout
// and the page itself, and both ask who the caller is. Each ask was its own
// round trip to Supabase Auth plus a read of `users`, one after the other,
// before any of the page was sent. Now the second ask gets the first one's
// answer. The cache lives for one request only — the next click asks again,
// so a deactivated user or a changed role still takes effect at once.
export const getAppUser = cache(readAppUser);

async function readAppUser(): Promise<AppUser | null> {
  const fromToken = await callerFromBearerToken();
  if (fromToken) return fromToken;

  const supabase = supabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("users")
    .select(USER_COLUMNS)
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (error || !data || !data.is_active) return null;
  return actingAs(data as AppUser, cookies().get(ACT_AS_COOKIE)?.value);
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
