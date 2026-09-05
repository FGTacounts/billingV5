-- ============================================================
-- FGT Billing — put back the order dates. Second attempt.
--
-- RUN-ME-10 did not take: your orders still carry the two
-- timestamps it was meant to clear, so something in it errored
-- and the whole thing rolled back. This version does the same
-- work as ONE statement, tells you how many rows it fixed, and
-- if it cannot disable the trigger it says exactly why — send
-- me that line and I will work around it.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run
-- (select nothing, so the editor runs all of it).
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The repair
--
-- `orders` has a trigger that sets updated_at = now() on every
-- update, and this app reads updated_at as the date an order was
-- billed. Clearing the blanket extended_due_date in RUN-ME-9
-- therefore stamped today on 527 orders. Every one of them now
-- looks as though it was invoiced this morning, which is why the
-- dashboard's month-to-date figure is the whole year's sales.
--
-- Each order goes back to its last recorded status change, or
-- failing that its created_at — which for every imported invoice
-- is the real invoice date.
-- ------------------------------------------------------------
do $$
declare
  repaired integer;
  vat_fixed integer;
begin
  begin
    execute 'alter table public.orders disable trigger user';
  exception when others then
    raise exception
      'STOP — could not disable the trigger on orders: % (SQLSTATE %). Send this line back.',
      sqlerrm, sqlstate;
  end;

  update public.orders o
     set updated_at = coalesce(
           (select max(l.changed_at) from public.order_status_log l where l.order_id = o.id),
           o.created_at
         )
   where o.updated_at in (
           timestamptz '2026-09-04 07:00:29.809566+00',
           timestamptz '2026-09-04 07:06:42.298855+00'
         );
  get diagnostics repaired = row_count;

  -- While the trigger is out of the way, one more correction that would
  -- otherwise re-date the rows it touches: nine invoices carry a VAT amount
  -- of zero while their total is the subtotal plus 5% — the VAT was charged
  -- but never written down, so the tax line on those documents reads nil.
  update public.orders
     set vat_amount = round((total - subtotal)::numeric, 2)
   where subtotal is not null
     and total is not null
     and abs(total - subtotal - coalesce(vat_amount, 0)) > 0.02;
  get diagnostics vat_fixed = row_count;

  execute 'alter table public.orders enable trigger user';

  raise notice 'Orders put back to their real dates: %', repaired;
  raise notice 'Invoices whose VAT line was corrected: %', vat_fixed;
end
$$;


-- ------------------------------------------------------------
-- 2. Did it work?
--
--   "orders still stamped this morning" must be 0.
--   "orders dated today" should be a handful — the ones actually
--   worked on today.
--   "oldest order date" should be back in 2025.
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
       (select min(updated_at)::date::text from public.orders)
union all
select 'orders dated in September',
       (select count(*)::text from public.orders
         where updated_at >= date_trunc('month', current_date))
union all
select 'invoices whose VAT line still does not add up',
       (select count(*)::text from public.orders
         where subtotal is not null and total is not null
           and abs(total - subtotal - coalesce(vat_amount, 0)) > 0.02);


-- ------------------------------------------------------------
-- 3. Only if step 1 stopped with the STOP message above.
--
-- Run this on its own and send me what it prints — it names the
-- trigger and who owns the table, which is everything I need to
-- write a version that works without disabling anything.
-- ------------------------------------------------------------
-- select t.tgname,
--        t.tgenabled,
--        pg_get_triggerdef(t.oid)      as definition,
--        pg_get_userbyid(c.relowner)   as table_owner,
--        current_user                  as running_as
--   from pg_trigger t
--   join pg_class c on c.oid = t.tgrelid
--  where t.tgrelid = 'public.orders'::regclass
--    and not t.tgisinternal;
