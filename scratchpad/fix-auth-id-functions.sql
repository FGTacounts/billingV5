-- Famlist Billing — repair current_app_user_id() and current_role_is().
--
-- THE PROBLEM
-- Both functions still look up public.users by a column called `auth_id`.
-- That column was renamed to `auth_user_id` at some point, so both functions
-- now fail outright:
--
--     select current_app_user_id();
--     ERROR:  column "auth_id" does not exist   (SQLSTATE 42703)
--
-- Every RLS policy that calls either one fails the same way, which is why a
-- plain query against `expenses` returns a 42703 error instead of rows. The
-- app has been working around this by doing all its reads and writes through
-- the service role in server-side routes, with the caller's role re-checked
-- in the route itself — so nothing is broken for users today.
--
-- But it does mean the RLS layer is currently inert: it is not adding any
-- protection on top of those route checks, and anyone who later writes a
-- direct client query, or turns a policy back on, gets an error rather than
-- the enforcement they think they're getting. This restores it.
--
-- Verify afterwards with:
--     select public.current_app_user_id();          -- null when not signed in, no error
--     select public.current_role_is('manager');     -- false when not signed in, no error
--
-- Safe to re-run. The signatures are unchanged, so the existing policies keep
-- working without being touched.
--
-- CHECK THIS FIRST. I could confirm through the API that the argument is
-- named `r` and that 'admin' is a valid role value, but not the exact name of
-- the enum type. Run this and confirm it prints `current_role_is(r user_role)`
-- — if the type is called something other than `user_role`, substitute that
-- name everywhere below before running the rest. Getting it wrong would
-- create a second, unused overload rather than replacing the broken one, and
-- the policies would go on failing.
--
--     select p.proname, pg_get_function_arguments(p.oid) as args
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('current_role_is', 'current_app_user_id');

-- The signed-in user's row id in public.users, or null when not signed in.
-- `stable` (not `volatile`) so the planner can call it once per query rather
-- than once per row — this runs inside every policy check.
-- `security definer` so the lookup isn't itself blocked by RLS on users,
-- with an empty search_path so the function can't be hijacked by a caller
-- putting their own `users` table earlier on the path.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1
$$;

-- True when the signed-in user holds the given role. Kept as a single-arg
-- function named `r` so the existing policies and PostgREST calls that
-- reference it keep resolving.
--
-- Treats admin as satisfying a 'manager' check: the app's own route guards
-- all use `role === "manager" || role === "admin"`, and without this an
-- admin session would be refused by every manager-gated policy.
create or replace function public.current_role_is(r public.user_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active
      -- `users.role` is a text column, while the parameter is the user_role
      -- enum, and Postgres has no text = user_role operator. Compared as text
      -- on both sides. The parameter keeps the enum type so existing policies
      -- calling current_role_is(user_role) still resolve to this function.
      and (u.role = r::text or (r::text = 'manager' and u.role = 'admin'))
  )
$$;

-- Both are called from RLS policies evaluated as the requesting role, so
-- those roles need execute. security definer is what makes this safe: the
-- functions only ever report on auth.uid(), which the caller cannot forge.
grant execute on function public.current_app_user_id() to anon, authenticated;
grant execute on function public.current_role_is(public.user_role) to anon, authenticated;
