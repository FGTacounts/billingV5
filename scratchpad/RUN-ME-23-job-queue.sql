-- ============================================================
-- FGT Billing — long work gets a queue instead of a request.
--
-- Rule 8 has never been true in this codebase, and docs/DECISIONS.md
-- says so in as many words (2026-09-12: "Rule 8 says long-running
-- work goes on a queue; the bulk invoice export and the AI scans run
-- in request handlers").
--
-- What that costs today:
--
--   /api/invoices/download-all   builds up to 200 invoice PDFs and
--                                zips them inside one request. On a
--                                serverless host that request is
--                                killed at the platform limit and
--                                the manager gets nothing — no file,
--                                no error worth reading, and no
--                                record that it was ever attempted.
--   /api/orders/import           a whole spreadsheet, row by row, in
--                                the handler.
--   /api/scan-order              an AI document read, already at
--   /api/scan-articles           maxDuration = 60 because 10 was not
--                                enough.
--
-- This table is the queue. A request now writes one row and returns
-- an id; the work happens afterwards in a worker request that is
-- allowed to fail, be retried, and be watched while it runs. A
-- failure lands in `error` on the row instead of vanishing with the
-- connection.
--
-- There is no worker host and no Redis, on purpose: this project runs
-- on free tiers. Postgres is the queue — one table, one conditional
-- UPDATE to claim a row, which is all a single-business workload of a
-- few jobs a day needs.
--
-- A note on org_id: rule 3 asks for RLS enabled and FORCEd on every
-- table, and explicitly asks for NO tenancy column — there is one
-- business, settled 2026-09-12. This table follows the pattern every
-- other table uses: the same current_app_user_id() / current_role_is()
-- helpers do the scoping, keyed on who is signed in.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. One row per piece of work
--
-- `kind` says what to do and `params` says what to do it to, so a
-- worker needs nothing from the request that queued it. `result`
-- carries the answer back — and while the job is still running it
-- carries how far it has got, which is what the progress on screen
-- is read from. `error` is the reason a failed job failed, kept so
-- the person who asked can be told rather than left watching a
-- button that never finishes.
--
-- Every timestamp is timestamptz (rule 7), so they are stored in UTC
-- and read back in the reader's own zone. Duration is never stored:
-- it is finished_at - started_at, and a stored copy would only be
-- something new to disagree with.
-- ------------------------------------------------------------
create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null,
  status        text not null default 'queued',
  requested_by  uuid not null references public.users(id),
  params        jsonb not null default '{}'::jsonb,
  result        jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  constraint jobs_status_known
    check (status in ('queued', 'running', 'done', 'failed')),
  constraint jobs_finished_has_an_outcome
    check ((status in ('done', 'failed')) = (finished_at is not null))
);

comment on table public.jobs is
  'Rule 8 queue. One row per long-running piece of work: kind + params in, result or error out.';

comment on column public.jobs.result is
  'While running, how far it has got. Once done, what it produced.';


-- ------------------------------------------------------------
-- 2. Finding work, and finding your own work
--
-- The worker asks for the oldest queued row; the screen that is
-- waiting asks for its own recent rows. Both are one index.
-- ------------------------------------------------------------
create index if not exists jobs_queued_idx
  on public.jobs (created_at)
  where status = 'queued';

create index if not exists jobs_requested_by_created_idx
  on public.jobs (requested_by, created_at desc);


-- ------------------------------------------------------------
-- 3. Who may queue, run and watch what
--
-- A job belongs to the person who asked for it. They queue it, they
-- run it, they watch it. A manager reads everyone's, because when a
-- salesman says "the import did nothing" the manager is the one who
-- has to find out why — but a manager does not run somebody else's
-- job, because the work is done with that person's own permissions
-- and stepping into it would quietly launder them.
--
-- current_role_is('manager') already counts an admin as a manager,
-- so admins are covered without a second policy.
--
-- Whether a given person is allowed to do the WORK is not decided
-- here: the worker re-checks the caller's role for the kind it is
-- about to run, exactly as the old request handlers did. This table
-- only decides who owns the row.
-- ------------------------------------------------------------
alter table public.jobs enable row level security;
alter table public.jobs force row level security;

drop policy if exists "read own jobs" on public.jobs;
create policy "read own jobs"
  on public.jobs for select to authenticated
  using (public.current_role_is('manager') or requested_by = public.current_app_user_id());

drop policy if exists "queue own work" on public.jobs;
create policy "queue own work"
  on public.jobs for insert to authenticated
  with check (requested_by = public.current_app_user_id());

drop policy if exists "run own work" on public.jobs;
create policy "run own work"
  on public.jobs for update to authenticated
  using (requested_by = public.current_app_user_id())
  with check (requested_by = public.current_app_user_id());

-- Deliberately no delete policy. A finished job is the record that
-- the work was asked for and what came of it; a failed one is the
-- only place the reason survives.

-- The anonymous role is already shut out of this schema by RUN-ME-13,
-- including from tables made later. Said again here in so many words,
-- because `npm run test:tenancy` will probe this table the moment it
-- exists and a queue is a write endpoint.
--
-- PUBLIC is named as well as anon, and that is the whole lesson of
-- RUN-ME-24: revoking from anon takes nothing away when the grant is
-- actually held by PUBLIC, the pseudo-role every role inherits from.
-- `create table` grants PUBLIC nothing, so this should be a no-op —
-- which is exactly when it is cheapest to be sure.
--
-- `authenticated` is deliberately not revoked: the policies above are
-- what decide who may do what, and they need the grant to decide on.
revoke all on public.jobs from public;
revoke all on public.jobs from anon;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'jobs table' as item,
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='jobs')
            then 'OK' else 'MISSING' end as status
union all
select 'every column present',
       case when (select count(*) from information_schema.columns
                   where table_schema='public' and table_name='jobs'
                     and column_name in ('id','kind','status','requested_by',
                                         'params','result','error',
                                         'created_at','started_at','finished_at')) = 10
            then 'OK' else 'MISSING' end
union all
select 'timestamps are timestamptz',
       case when not exists (select 1 from information_schema.columns
                              where table_schema='public' and table_name='jobs'
                                and column_name in ('created_at','started_at','finished_at')
                                and data_type <> 'timestamp with time zone')
            then 'OK' else 'WRONG TYPE' end
union all
select 'status is one of four',
       case when exists (select 1 from pg_constraint
                          where conname = 'jobs_status_known')
            then 'OK' else 'MISSING' end
union all
select 'row level security forced',
       case when exists (select 1 from pg_class c
                          join pg_namespace n on n.oid = c.relnamespace
                          where n.nspname='public' and c.relname='jobs'
                            and c.relrowsecurity and c.relforcerowsecurity)
            then 'OK' else 'NOT FORCED' end
union all
select 'three policies',
       case when (select count(*) from pg_policies
                   where schemaname='public' and tablename='jobs') = 3
            then 'OK' else 'MISSING' end
union all
select 'no tenancy column',
       case when not exists (select 1 from information_schema.columns
                              where table_schema='public' and table_name='jobs'
                                and column_name = 'org_id')
            then 'OK' else 'REMOVE IT' end
union all
select 'nothing granted to anon or PUBLIC',
       case when not exists (
              select 1 from information_schema.role_table_grants
              where table_schema='public' and table_name='jobs'
                and grantee in ('anon', 'PUBLIC'))
            then 'OK' else 'STILL GRANTED' end
union all
select 'signed-in staff can still use the queue',
       case when has_table_privilege('authenticated', 'public.jobs', 'SELECT')
             and has_table_privilege('authenticated', 'public.jobs', 'INSERT')
             and has_table_privilege('authenticated', 'public.jobs', 'UPDATE')
            then 'OK' else 'GRANT SELECT, INSERT, UPDATE ON public.jobs TO authenticated' end
union all
select 'both indexes',
       case when (select count(*) from pg_indexes
                   where schemaname='public' and tablename='jobs'
                     and indexname in ('jobs_queued_idx','jobs_requested_by_created_idx')) = 2
            then 'OK' else 'MISSING' end
union all
select 'helpers this table leans on',
       case when (select count(*) from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname='public'
                     and p.proname in ('current_role_is','current_app_user_id')) >= 2
            then 'OK' else 'RUN RUN-ME-all-pending.sql FIRST' end;
