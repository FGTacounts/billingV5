-- ============================================================
-- FGT Billing — a manager can remove a line again.
--
-- Found 2026-09-26: removing a line from order 4480 as a manager
-- was refused with
--
--     invalid input value for enum public.user_role: "admin"
--
-- manager_edit_order (RUN-ME-28) opens with
--
--     public.current_role_is('manager') or public.current_role_is('admin')
--
-- current_role_is takes the user_role enum, which has no 'admin'
-- member — RUN-ME-17 explains why, and why the enum is left alone.
-- Postgres turns 'admin' into that enum before it runs anything,
-- so the check fails for EVERYONE, manager included. Every manager
-- edit through that function has been refused since RUN-ME-28 was
-- run: removing a line, changing a quantity or price, adding an
-- article, picking or unpicking, rearranging, the order discount —
-- on the web and on the phone.
--
-- The same words are in two other checks, which are broken the
-- same way:
--   • orders_keep_billed_at (RUN-ME-27) — a manager setting an
--     order's billing date by hand;
--   • the guard on which actions need approval (RUN-ME-26) — an
--     admin switching those settings.
--
-- The fix: public.current_user_is_admin() (RUN-ME-17), which
-- compares the text column and so can say "admin". Every function
-- in the live database that still says current_role_is('admin') is
-- rewritten in place from its own live definition — only those
-- words change, and its grants stay as they are.
--
-- Nothing about who may do what changes: this makes the checks do
-- what they were written to do.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================

do $$
declare
  f   record;
  def text;
begin
  for f in
    select p.oid, p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%current_role_is(''admin'')%'
  loop
    def := pg_get_functiondef(f.oid);
    def := replace(def, 'public.current_role_is(''admin'')', 'public.current_user_is_admin()');
    def := replace(def, 'current_role_is(''admin'')', 'public.current_user_is_admin()');
    execute def;
    raise notice 'Fixed %', f.sig;
  end loop;
end
$$;


-- ------------------------------------------------------------
-- What you should see: one row, saying 0.
-- ------------------------------------------------------------
select count(*) as functions_still_saying_current_role_is_admin
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.prosrc like '%current_role_is(''admin'')%';
