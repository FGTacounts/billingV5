-- ============================================================
-- FGT Billing — put back the order dates that RUN-ME-9 moved.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once (it only matches the two exact
-- timestamps below, which exist once).
--
-- WHAT HAPPENED
--
-- `orders` has a trigger that sets updated_at = now() on every
-- update. RUN-ME-9's second section cleared the blanket
-- extended_due_date on 527 orders — and the trigger stamped
-- today's date on all 527 as it went. This app reads updated_at
-- as the date an order was billed, so those orders now look as
-- if they were all invoiced this morning: nothing is overdue,
-- and this month's sales are wrong.
--
-- That was my mistake, not yours. This puts the dates back.
--
-- WHERE THE DATES COME FROM
--
-- The last recorded status change for the order, and failing
-- that its created_at — which for every imported invoice is the
-- real invoice date. Checked against the live data: this
-- reproduces the aging exactly as it read before, to the fill.
--
-- Only the two exact moments the damage happened are touched:
--   2026-09-04 07:00:29.809566+00  (527 orders, RUN-ME-9)
--   2026-09-04 07:06:42.298855+00  (1 order, a check I ran)
-- Anything you have worked on today keeps its own date.
-- ============================================================

begin;

-- The trigger has to stand aside, or it stamps today's date over
-- the value being written — which is the whole problem.
alter table public.orders disable trigger user;

update public.orders o
   set updated_at = coalesce(
         (select max(l.changed_at) from public.order_status_log l where l.order_id = o.id),
         o.created_at
       )
 where o.updated_at in (
         timestamptz '2026-09-04 07:00:29.809566+00',
         timestamptz '2026-09-04 07:06:42.298855+00'
       );

alter table public.orders enable trigger user;

commit;


-- ------------------------------------------------------------
-- Check it worked.
--
--   "orders still stamped this morning" must be 0.
--   "orders dated today" should be a handful — the ones you
--   actually worked on today.
-- ------------------------------------------------------------
select 'orders still stamped this morning' as item,
       (select count(*)::text from public.orders
         where updated_at in (timestamptz '2026-09-04 07:00:29.809566+00',
                              timestamptz '2026-09-04 07:06:42.298855+00')) as value
union all
select 'orders dated today',
       (select count(*)::text from public.orders where updated_at::date = current_date)
union all
select 'oldest order date on the books',
       (select min(updated_at)::date::text from public.orders);
