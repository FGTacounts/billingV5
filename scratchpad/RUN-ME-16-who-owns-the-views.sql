-- ============================================================
-- FGT Billing — RUN-ME-15 said "must be owner of view".
--
-- Before running this: look at the SQL editor's ROLE selector.
-- It is the small person/role control near the Run button (in
-- some versions a dropdown at the bottom-right of the editor).
-- If it says `authenticated` or `anon`, set it back to
-- `postgres`. That single setting explains both errors you have
-- hit today — the one about auth.users and this one — because
-- `authenticated` owns nothing and may read almost nothing.
--
-- Then paste this whole file and run it.
--
-- Step 1 prints who you are and who owns the two views.
-- Step 2 does the actual fix.
-- If step 2 still refuses, send me what step 1 printed.
-- ============================================================


-- ------------------------------------------------------------
-- STEP 1 — who is running this, and who owns what
--
-- `current_user` should say postgres. If it says authenticated,
-- stop here and change the role selector.
-- ------------------------------------------------------------
select current_user                    as running_as,
       session_user                    as signed_in_as,
       c.relname                       as view_name,
       pg_get_userbyid(c.relowner)     as owned_by
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('products_safe', 'order_items_safe');


-- ------------------------------------------------------------
-- STEP 2 — the fix itself
--
-- Puts both views back to running as their owner, which is what
-- lets them show cost figures to people who are not granted the
-- cost column. Nothing else changes: the anonymous role stays
-- locked out, which is what actually closed the leak.
-- ------------------------------------------------------------
alter view public.products_safe    set (security_invoker = false);
alter view public.order_items_safe set (security_invoker = false);


-- ------------------------------------------------------------
-- STEP 3 — proof it worked. Both rows should say OK.
-- ------------------------------------------------------------
select 'products_safe runs as its owner' as item,
       case when not coalesce((select (reloptions::text like '%security_invoker=true%')
                                 from pg_class where relname = 'products_safe'), false)
            then 'OK' else 'STILL WRONG' end as status
union all
select 'order_items_safe runs as its owner',
       case when not coalesce((select (reloptions::text like '%security_invoker=true%')
                                 from pg_class where relname = 'order_items_safe'), false)
            then 'OK' else 'STILL WRONG' end;
