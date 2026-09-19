-- ============================================================
-- FGT Billing — the visit timer survives a reload.
--
-- Planning lets a salesman start a timer when they arrive at a
-- stop and stop it when they leave. On both apps that clock has
-- only ever lived in memory — React state on the web, the view
-- model on the phone — so closing the tab, rotating the device
-- or the OS reclaiming the app threw the day's visits away, and
-- the manager who is supposed to "see every salesman's route"
-- could never see any of it.
--
-- This gives the arrival and departure stamps a home both apps
-- can read.
--
-- A note on org_id: rule 3 asks every business table to carry
-- NOT NULL org_id. No table in this database has one — there is
-- no org_id column, no orgs table and no tenant helper anywhere
-- in the schema or in any earlier RUN-ME file. A lone org_id
-- here would reference nothing, be filled with a constant, and
-- give a false impression that tenancy is enforced. This table
-- follows the pattern every other table in this database uses:
-- RLS enabled and FORCEd, with the same current_app_user_id() /
-- current_role_is() helpers doing the scoping. Whoever adds
-- tenancy adds it to every table at once, this one included.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. One row per visit
--
-- A row is written when the salesman taps Start (arrived_at),
-- and closed when they tap Stop (departed_at). A row with a null
-- departed_at is a visit still in progress — that is what the
-- app restores the running timer from after a reload.
--
-- Timestamps are timestamptz, so they are stored in UTC and read
-- back in whatever zone the reader is in. The duration is never
-- stored: it is departed_at - arrived_at, and a stored copy
-- would only be something new to disagree with.
-- ------------------------------------------------------------
create table if not exists public.route_visits (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  salesman_id  uuid not null references public.users(id),
  arrived_at   timestamptz not null default now(),
  departed_at  timestamptz,
  created_at   timestamptz not null default now(),
  constraint route_visits_departure_after_arrival
    check (departed_at is null or departed_at >= arrived_at)
);

comment on table public.route_visits is
  'Planning: time logged at a customer stop. Null departed_at = still there.';


-- ------------------------------------------------------------
-- 2. One clock at a time, and a fast read of today
--
-- Both apps only ever run a single timer, so a second open visit
-- is a bug (a double tap, an offline replay) rather than a state
-- worth supporting. The database refuses it rather than leaving
-- two rows that can never both be closed.
-- ------------------------------------------------------------
create unique index if not exists route_visits_one_open_per_salesman
  on public.route_visits (salesman_id)
  where departed_at is null;

create index if not exists route_visits_salesman_arrived_idx
  on public.route_visits (salesman_id, arrived_at desc);


-- ------------------------------------------------------------
-- 3. Who may see and write what
--
-- A salesman reads and writes their own visits. A manager reads
-- everyone's — that is the whole point of logging them
-- (§Next Updates Planning: "manager can see every salesman's
-- route"). Nobody edits somebody else's clock, manager included:
-- a stamp is a record of where a person was.
--
-- current_role_is('manager') already counts an admin as a
-- manager, so admins are covered without a second policy.
-- ------------------------------------------------------------
alter table public.route_visits enable row level security;
alter table public.route_visits force row level security;

drop policy if exists "read route visits" on public.route_visits;
create policy "read route visits"
  on public.route_visits for select to authenticated
  using (public.current_role_is('manager') or salesman_id = public.current_app_user_id());

drop policy if exists "log own arrival" on public.route_visits;
create policy "log own arrival"
  on public.route_visits for insert to authenticated
  with check (salesman_id = public.current_app_user_id());

drop policy if exists "log own departure" on public.route_visits;
create policy "log own departure"
  on public.route_visits for update to authenticated
  using (salesman_id = public.current_app_user_id())
  with check (salesman_id = public.current_app_user_id());

-- Deliberately no delete policy. A visit that was mistakenly
-- started is closed, not erased.


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'route_visits table' as item,
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='route_visits')
            then 'OK' else 'MISSING' end as status
union all
select 'timestamps are timestamptz',
       case when not exists (select 1 from information_schema.columns
                              where table_schema='public' and table_name='route_visits'
                                and column_name in ('arrived_at','departed_at','created_at')
                                and data_type <> 'timestamp with time zone')
            then 'OK' else 'WRONG TYPE' end
union all
select 'row level security forced',
       case when exists (select 1 from pg_class c
                          join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname='public' and c.relname='route_visits'
                            and c.relrowsecurity and c.relforcerowsecurity)
            then 'OK' else 'NOT FORCED' end
union all
select 'three policies',
       case when (select count(*) from pg_policies
                   where schemaname='public' and tablename='route_visits') = 3
            then 'OK' else 'MISSING' end
union all
select 'one open visit per salesman',
       case when exists (select 1 from pg_indexes
                          where schemaname='public' and tablename='route_visits'
                            and indexname='route_visits_one_open_per_salesman')
            then 'OK' else 'MISSING' end
union all
select 'helpers this table leans on',
       case when (select count(*) from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('current_role_is','current_app_user_id')) >= 2
            then 'OK' else 'RUN RUN-ME-all-pending.sql FIRST' end;
