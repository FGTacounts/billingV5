-- RUN-ME-17 (v2) — The Admin account cannot see any orders or payments.
--
-- Measured 2026-09-05 with a real session for each role:
--
--     role        orders   payments
--     admin            0          0     <-- blind
--     manager        535         22
--     salesman       184          9     (own only — correct)
--     warehouse      535          0
--
-- Every other table is fine; only these two are wrong. That is why the iOS
-- dashboard signed in as Bilal (Admin) shows Sale 0, Orders 0, GP 0% and
-- "No more orders left" while the database holds 535 orders and AED 1.2M.
--
-- WHY it was never fixable before: `users.role` is a TEXT column and happily
-- stores 'admin', but the existing helper takes the ENUM public.user_role,
-- which has no 'admin' member. So `current_role_is('admin')` cannot even be
-- parsed — that is the 22P02 error v1 of this file hit. There was literally
-- no way to write "is an admin" into a policy, which is why the policies on
-- orders and payments enumerate only manager/salesman/warehouse.
--
-- The fix is a second helper that compares the text column directly. The
-- enum is left alone: ALTER TYPE ... ADD VALUE cannot be used in the same
-- transaction that then references the new value, and nothing else needs it.
--
-- RLS permissive policies are OR'd together, so this ADDS an admin policy to
-- each table and does not touch the existing ones. Nothing any other role
-- can see today changes.
--
-- Run in the Supabase SQL editor with the role selector on `postgres`.

-- ── Step 1 — what is there now (this is the evidence, read the output) ─────
select tablename, policyname, cmd, qual as using_expression
  from pg_policies
 where schemaname = 'public'
   and tablename in ('orders', 'payments')
 order by tablename, cmd, policyname;

-- ── Step 2 — a helper that can actually say "admin" ───────────────────────
-- SECURITY DEFINER so a policy can call it without the caller needing to
-- read public.users, which would recurse through that table's own RLS.
-- Mirrors the style of public.current_role_is (empty search_path, fully
-- qualified names).

create or replace function public.current_user_is_admin()
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
       and lower(u.role) = 'admin'
  );
$$;

grant execute on function public.current_user_is_admin() to authenticated;

-- ── Step 3 — give Admin the same reach as Manager ─────────────────────────
drop policy if exists "admin full access to orders" on public.orders;
create policy "admin full access to orders"
  on public.orders
  for all
  using      (public.current_user_is_admin())
  with check (public.current_user_is_admin());

drop policy if exists "admin full access to payments" on public.payments;
create policy "admin full access to payments"
  on public.payments
  for all
  using      (public.current_user_is_admin())
  with check (public.current_user_is_admin());

-- ── Step 4 — confirm ──────────────────────────────────────────────────────
select tablename, policyname, cmd
  from pg_policies
 where schemaname = 'public'
   and policyname like 'admin full access%'
 order by tablename;
