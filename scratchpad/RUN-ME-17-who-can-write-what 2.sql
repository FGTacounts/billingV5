-- RUN-ME-17 — Read-only audit + one small fix.
--
-- Run this in the Supabase SQL editor with the ROLE SELECTOR SET TO postgres.
-- (If it is set to `authenticated` you will get "permission denied" or
-- "must be owner" — that is what bit RUN-ME-15.)
--
-- Steps 1-3 CHANGE NOTHING. They print what is currently true so we can see
-- whether a salesman or warehouse account is able to write things only a
-- manager should. Step 4 is the only statement that changes anything, and it
-- fixes one inconsistency: an `admin` can see product cost but not order-line
-- cost, so the admin login's gross-profit figures come out empty.

-- ─────────────────────────────────────────────────────────────────────
-- STEP 1 — Who is allowed to write to each table, per role?
-- Anything that says `authenticated` applies to EVERY signed-in user,
-- salesman and warehouse included.
-- ─────────────────────────────────────────────────────────────────────
select table_name,
       grantee,
       string_agg(privilege_type, ', ' order by privilege_type) as can
  from information_schema.role_table_grants
 where table_schema = 'public'
   and grantee in ('anon', 'authenticated', 'service_role')
   and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
 group by table_name, grantee
 order by table_name, grantee;

-- ─────────────────────────────────────────────────────────────────────
-- STEP 2 — The row-level rules. This is what actually decides whether a
-- salesman can, say, confirm someone else's payment. A table with RLS on
-- and NO policy for a command means nobody can run that command.
-- ─────────────────────────────────────────────────────────────────────
select c.relname            as table_name,
       c.relrowsecurity     as rls_enabled,
       c.relforcerowsecurity as rls_forced,
       p.polname            as policy,
       case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                     when 'w' then 'UPDATE' when 'd' then 'DELETE'
                     else 'ALL' end as command,
       pg_get_expr(p.polqual,      p.polrelid) as using_rule,
       pg_get_expr(p.polwithcheck, p.polrelid) as with_check_rule
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policy p on p.polrelid = c.oid
 where n.nspname = 'public'
   and c.relkind = 'r'
 order by c.relname, command;

-- ─────────────────────────────────────────────────────────────────────
-- STEP 3 — The two cost-masking helpers, printed so we can read the rule
-- they apply rather than guess at it.
-- ─────────────────────────────────────────────────────────────────────
select p.proname, pg_get_functiondef(p.oid) as definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('viewer_sees_cost', 'current_role_is', 'current_app_user_id');

select c.relname as view_name, pg_get_viewdef(c.oid, true) as definition
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('products_safe', 'order_items_safe');

-- ─────────────────────────────────────────────────────────────────────
-- STEP 4 — Nothing to run yet. This file changes NOTHING.
--
-- There is one real inconsistency to fix: signed in as `admin` you can see
-- cost on products but unit_cost comes back null on order lines, so every
-- gross-profit figure is blank for the admin login and correct for the
-- manager login. The fix is a one-line change to whichever of
-- viewer_sees_cost() or order_items_safe carries the narrower rule — and
-- STEP 3 prints both, so send me that output and I will write the exact
-- statement rather than guess at a definition I cannot read from here.
-- Overwriting a masking function blind is how cost prices end up visible to
-- the whole company.
