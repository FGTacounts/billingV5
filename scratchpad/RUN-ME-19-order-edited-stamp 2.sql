-- ============================================================
-- FGT Billing — an order remembers that it was changed.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. Adds columns only; it does not
-- touch a single existing row, so nothing gets re-dated.
--
-- Once an order has been sent, anybody who changes what is on
-- it — a quantity, a price, a line added or taken off — leaves
-- a stamp: when, and who. The apps read it to show a small
-- "Edited" pill beside the status, so a manager approving an
-- order can see it is not the one that was sent to them.
--
-- Until this file has been run the apps behave exactly as they
-- did before: nothing is stamped and no pill is ever shown.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The stamp
--
-- timestamptz, in UTC, like every other time in the schema.
-- edited_by points at the staff member, not at a name, so it
-- still reads correctly after somebody is renamed.
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists edited_at timestamptz;

alter table public.orders
  add column if not exists edited_by uuid references public.users(id);

comment on column public.orders.edited_at is
  'When the contents of this order were last changed after it was sent. Null = never edited.';

comment on column public.orders.edited_by is
  'Who last changed the contents of this order. Null = never edited.';


-- ------------------------------------------------------------
-- 2. Finding the edited ones
--
-- Orders lists ask for the stamp on every row, and the edited
-- ones are the small minority, so the index carries only those.
-- ------------------------------------------------------------
create index if not exists orders_edited_at_idx
  on public.orders (edited_at desc)
  where edited_at is not null;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'orders.edited_at' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='edited_at')
            then 'OK' else 'MISSING' end as status
union all
select 'orders.edited_at is timestamptz',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='edited_at'
                            and data_type='timestamp with time zone')
            then 'OK' else 'WRONG TYPE' end
union all
select 'orders.edited_by',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='orders'
                            and column_name='edited_by')
            then 'OK' else 'MISSING' end
union all
select 'orders.edited_by points at users',
       case when exists (select 1
                           from information_schema.table_constraints tc
                           join information_schema.key_column_usage kcu
                             on kcu.constraint_name = tc.constraint_name
                            and kcu.table_schema = tc.table_schema
                          where tc.table_schema='public'
                            and tc.table_name='orders'
                            and tc.constraint_type='FOREIGN KEY'
                            and kcu.column_name='edited_by')
            then 'OK' else 'MISSING' end
union all
select 'index on the edited ones',
       case when exists (select 1 from pg_indexes
                          where schemaname='public' and indexname='orders_edited_at_idx')
            then 'OK' else 'MISSING' end
union all
select 'orders stamped as edited so far',
       (select count(*)::text from public.orders where edited_at is not null);
