-- ============================================================
-- FGT Billing — RUN-ME-27 — a billing date a manager can change
--
-- Paste the whole file into Supabase -> SQL Editor -> Run, with the
-- ROLE SELECTOR SET TO postgres (select nothing, so all of it runs).
-- Safe to run more than once.
--
-- WHAT IT DOES
--
-- The app has always read orders.updated_at as the date an order was
-- billed, and the database re-stamps updated_at on EVERY update. So
-- correcting a note moved a sale to today, and one bulk update on
-- 2026-09-04 moved a year of sales into that morning.
--
-- IT HAS HAPPENED AGAIN, AND THIS FILE REPAIRS IT FIRST. On
-- 2026-09-19 at 15:56:46 UTC one update re-stamped 537 orders — every
-- one of them a delivered, imported invoice. Found on 2026-09-21 by
-- reading the live data: all 558 orders carried a September 2026
-- date, so "sales this month" was every sale ever made and nothing
-- was overdue. Step 2 puts those orders back the way RUN-ME-11 did:
-- the last recorded status change, else created_at, which for an
-- imported invoice is the real invoice date. (None of the 537 has a
-- status change on record, so in practice it is created_at.)
--
-- AND AGAIN on 2026-09-23 at 17:47:33 UTC: the same 537 orders,
-- re-stamped a third time, so the Sales page read AED 1.2m for this
-- month. The repair below no longer looks for one particular moment:
-- it puts back every order that shares its updated_at with more than
-- 20 others (no real invoice date looks like that), whenever the
-- re-stamp happened. Once this file has run, a re-stamp can no longer
-- move a sale, because sales read billed_at, which it does not touch.
--
-- This adds orders.billed_at:
--   * filled from updated_at AFTER that repair, so the only figures
--     that move when you run this are the ones that are wrong today;
--   * stamped from now on only when an order's STATUS changes — which
--     is when the billing date effectively changes today — and no
--     longer when somebody edits a note, a PO number or a line;
--   * a manager or admin can set it by hand (Orders -> open the order
--     -> Edit details -> Billing date). A date set by hand stays put:
--     later status changes do not overwrite it.
--
-- The apps read billed_at once it exists and updated_at until then,
-- so nothing breaks before or after you run this.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The columns
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists billed_at        timestamptz,
  add column if not exists billed_at_manual boolean not null default false;


-- ------------------------------------------------------------
-- 2. Fill it from updated_at — with the table's triggers out of the
--    way, because this is a bulk update of orders and the trigger
--    that stamps updated_at = now() is exactly what must not fire
--    (that is the 2026-09-04 accident). Same method as RUN-ME-11.
-- ------------------------------------------------------------
do $$
declare
  repaired integer;
  filled integer;
begin
  begin
    execute 'alter table public.orders disable trigger user';
  exception when others then
    raise exception
      'STOP — could not disable the triggers on orders: % (SQLSTATE %). Nothing was changed. Send this line back.',
      sqlerrm, sqlstate;
  end;

  -- The re-stamps (2026-09-19, 2026-09-23, any other), undone. Also puts updated_at itself right,
  -- because the web app and the phones already out there read updated_at
  -- until their new versions are installed.
  update public.orders o
     set updated_at = coalesce(
           (select max(l.changed_at) from public.order_status_log l where l.order_id = o.id),
           o.created_at
         )
   where o.updated_at in (
           select updated_at from public.orders
            where updated_at <> date_trunc('day', updated_at at time zone 'UTC') at time zone 'UTC'
            group by updated_at
           having count(*) > 20
         );
  get diagnostics repaired = row_count;

  update public.orders
     set billed_at = coalesce(updated_at, created_at, now())
   where billed_at is null;
  get diagnostics filled = row_count;

  execute 'alter table public.orders enable trigger user';

  raise notice 'Orders put back to their real dates (expected about 537 the first time, 0 after): %', repaired;
  raise notice 'Orders given a billing date: %', filled;
end
$$;

alter table public.orders alter column billed_at set default now();
alter table public.orders alter column billed_at set not null;

-- Every sales figure, the aging and the statements filter on this.
create index if not exists orders_billed_at_idx on public.orders (billed_at);


-- ------------------------------------------------------------
-- 3. Keeping it
--
--    Not security definer: it has to see who is really asking
--    (same as guard_user_privileged_columns in RUN-ME-20). The
--    service role is the server and the import tools, and passes.
-- ------------------------------------------------------------
create or replace function public.orders_keep_billed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- An imported invoice arrives with its real date in updated_at.
    new.billed_at := coalesce(new.billed_at, new.updated_at, now());
    return new;
  end if;

  if new.billed_at is distinct from old.billed_at then
    -- Somebody is setting the date by hand.
    if new.billed_at is null then
      raise exception 'An order must have a billing date.' using errcode = '23502';
    end if;
    if current_user <> 'service_role'
       and not (public.current_role_is('manager') or public.current_user_is_admin())
    then
      raise exception 'Only a manager can change an order''s billing date.'
        using errcode = '42501';
    end if;
    new.billed_at_manual := true;
  elsif new.status is distinct from old.status and not old.billed_at_manual then
    new.billed_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists orders_keep_billed_at on public.orders;
create trigger orders_keep_billed_at
  before insert or update on public.orders
  for each row execute function public.orders_keep_billed_at();


-- ------------------------------------------------------------
-- 4. What you should see
--
--    'billing date differs from updated_at' is 0 the first time you
--    run this: apart from the repair above, no order moved.
-- ------------------------------------------------------------
select 'orders' as item, count(*)::text as value from public.orders
union all
select 'orders without a billing date (must be 0)',
       count(*)::text from public.orders where billed_at is null
union all
select 'billing date differs from updated_at (0 the first time you run this)',
       count(*)::text from public.orders where billed_at is distinct from updated_at
union all
select 'orders still sharing one re-stamped moment with 20+ others (must be 0)',
       coalesce(sum(n), 0)::text from (
         select count(*) as n from public.orders
          where updated_at <> date_trunc('day', updated_at at time zone 'UTC') at time zone 'UTC'
          group by updated_at having count(*) > 20
       ) restamped
union all
select 'orders billed this month (should look like ONE month, not all of them)',
       count(*)::text from public.orders
        where billed_at >= date_trunc('month', now())
union all
select 'trigger installed',
       case when exists (select 1 from pg_trigger
                          where tgname = 'orders_keep_billed_at' and not tgisinternal)
            then 'yes' else 'NO' end;


-- ------------------------------------------------------------
-- 5. Any OTHER moment at which many orders were stamped together.
--    Should return no rows. If it returns some, send them to me:
--    it means another bulk update has moved billing dates.
--    (Imported invoices are dated at midnight and a dozen can share a
--    day, so exact-midnight dates are left out: those are real.)
-- ------------------------------------------------------------
select updated_at as stamped_at, count(*) as orders_sharing_it
  from public.orders
 where updated_at <> date_trunc('day', updated_at at time zone 'UTC') at time zone 'UTC'
 group by updated_at
having count(*) > 5
 order by count(*) desc;
