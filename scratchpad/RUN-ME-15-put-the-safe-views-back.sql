-- ============================================================
-- FGT Billing — URGENT. Undo one line of RUN-ME-13.
--
-- Paste into Supabase -> SQL Editor -> Run (as postgres, with
-- role impersonation off). Two statements, nothing else.
--
-- WHAT WENT WRONG
--
-- RUN-ME-13 did two separate things. Taking the anonymous role's
-- access away was right and it stays. Making products_safe and
-- order_items_safe run as the reader was wrong, and it is why
-- the Dashboard, Sales, Reports and the cost figures on Products
-- stopped loading.
--
-- Those two views exist precisely to hand cost figures to people
-- who are not allowed the cost column itself: the earlier
-- lockdown took `products.cost` and `order_items.unit_cost` away
-- from signed-in users, and the views give them back through a
-- masking function that blanks them for anyone who is not a
-- manager. A view running as its owner is what makes that work.
-- Running it as the reader means the reader needs the very
-- column they were never granted — so everyone, managers
-- included, gets "permission denied".
--
-- Measured against the live database as a signed-in manager:
--   products_safe      403 permission denied
--   order_items_safe   403 permission denied
--
-- The leak those views had is already closed by the other half
-- of RUN-ME-13: `anon` holds no privilege on them any more, so
-- nobody reaches them without signing in at all.
-- ============================================================

alter view public.products_safe    set (security_invoker = false);
alter view public.order_items_safe set (security_invoker = false);


-- ------------------------------------------------------------
-- Check it worked: both rows should say OK.
-- ------------------------------------------------------------
select 'products_safe readable' as item,
       case when (select count(*) from public.products_safe) >= 0 then 'OK' end as status
union all
select 'order_items_safe readable',
       case when (select count(*) from public.order_items_safe) >= 0 then 'OK' end;
