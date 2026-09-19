-- ============================================================
-- FGT Billing — a trash can for orders.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. Adds columns only; it does not
-- touch a single existing row, so nothing gets re-dated.
--
-- Deleting an order does not throw the row away. It moves to
-- the Trash in Orders, keeping its invoice number and its
-- history, and stops counting anywhere — sales, statements,
-- receivables. Its stock goes back on the shelf and any payment
-- that was applied to it is released back to the customer.
-- Restoring puts it back where it was.
-- ============================================================

alter table public.orders add column if not exists deleted_at timestamptz;
alter table public.orders add column if not exists deleted_by uuid references public.users(id);
-- Where it came from, so Restore can put it back at the same stage.
alter table public.orders add column if not exists deleted_from_status text;

create index if not exists orders_trash_idx
  on public.orders (deleted_at desc)
  where deleted_at is not null;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'orders.deleted_at' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='deleted_at')
            then 'OK' else 'MISSING' end as status
union all
select 'orders.deleted_by',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='deleted_by')
            then 'OK' else 'MISSING' end
union all
select 'orders.deleted_from_status',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='deleted_from_status')
            then 'OK' else 'MISSING' end
union all
select 'orders currently in the trash',
       (select count(*)::text from public.orders where deleted_at is not null);
