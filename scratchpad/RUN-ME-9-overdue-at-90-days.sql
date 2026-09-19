-- ============================================================
-- FGT Billing — an invoice is overdue at 90 days, not 30, and
-- an extension has to be a real one.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- Measured against the live database on 4 Sep 2026.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Ninety days
--
-- The company setting and every single customer still said 30 —
-- the old default. That is why the Payments page read
-- AED 1,096,342.57 overdue against AED 131,669.55 remaining:
-- everything older than a month was being called overdue.
--
-- A customer can still be given their own terms; this moves the
-- default and the rows that were never changed from it.
-- ------------------------------------------------------------
update public.app_settings
   set overdue_threshold_days = 90
 where overdue_threshold_days is distinct from 90;

update public.customers
   set overdue_threshold_days = 90
 where overdue_threshold_days = 30;

alter table public.customers
  alter column overdue_threshold_days set default 90;


-- ------------------------------------------------------------
-- 2. Clear the blanket "extended due date"
--
-- READ THIS BEFORE RUNNING IT.
--
-- 527 of the 535 billed orders carry an extended due date, and
-- they carry the same one: 526 say 2026-09-03 and one says
-- 2026-08-19. There is not a single approved extension request
-- behind any of them. That is a mass write, not 527 decisions.
--
-- It matters because aging counts from the extension when there
-- is one. With these in place every invoice — including ones
-- from November last year — reads as a day or two old, so the
-- Customers page, the statements and the new Payments figures
-- all show almost nothing overdue.
--
-- This clears exactly those two dates. Anything a manager
-- extends from today on is untouched, and approving an
-- extension request now writes the date itself.
-- ------------------------------------------------------------
-- `orders` carries a trigger that sets updated_at = now() on any
-- update, and this app reads updated_at as the date an order was
-- billed. Without standing the trigger aside, clearing a column
-- here would re-date every order it touches — which is exactly
-- what happened the first time this file was run, and what
-- RUN-ME-10 puts back.
begin;
alter table public.orders disable trigger user;

update public.orders
   set extended_due_date = null
 where extended_due_date in (date '2026-09-03', date '2026-08-19');

alter table public.orders enable trigger user;
commit;

-- If the column was created with a default, every new order
-- would inherit an extension it was never granted.
alter table public.orders
  alter column extended_due_date drop default;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'company threshold is 90' as item,
       case when exists (select 1 from public.app_settings where overdue_threshold_days = 90)
            then 'OK' else 'NOT SET' end as status
union all
select 'no customer left on 30 days',
       case when not exists (select 1 from public.customers where overdue_threshold_days = 30)
            then 'OK' else 'SOME STILL 30' end
union all
select 'new customers default to 90',
       case when exists (
              select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'customers'
                 and column_name = 'overdue_threshold_days'
                 and column_default like '%90%')
            then 'OK' else 'NOT SET' end
union all
select 'blanket extensions cleared',
       case when not exists (
              select 1 from public.orders
               where extended_due_date in (date '2026-09-03', date '2026-08-19'))
            then 'OK' else 'STILL THERE' end
union all
select 'extensions still standing (should be few)',
       (select count(*)::text from public.orders where extended_due_date is not null);
