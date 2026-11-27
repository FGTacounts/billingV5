-- ============================================================
-- FGT Billing — log the road each salesman drives, every day.
--
-- The company iPhones and iPads a salesman signs in on record
-- where they are while the working window is open (5 am to
-- midnight, device time — see section 3) and send the points here
-- in batches. A manager picks a salesman and a date on Planning
-- (web, iPhone, iPad, Mac) and sees that day's route on the map.
-- (The window became 5 am to midnight in RUN-ME-47; this file
-- now says the same, so running it again does not undo that.)
--
-- Only the salesman's own device writes their points. Only a
-- manager or admin reads anybody else's. Nothing is ever
-- edited or deleted: a point is a record of where a device was.
-- Kept forever (owner, 2026-11-27: "forever if possible").
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says isdeheipdfmwzmmnnidr first.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. One row per GPS point
--
-- Kept narrow on purpose: this is the fastest-growing table in
-- the database. A device records a point only after moving
-- about 150 m, so a parked van writes nothing; a busy day is
-- roughly 500-1,000 points, about 100 KB per salesman per day
-- with the index.
--
-- The key is (who, when). A batch the phone sends twice — the
-- reply was lost on a bad signal and it tried again — lands on
-- the same keys and is ignored, not stored twice.
--
-- Coordinates are degrees (WGS84, as the phone reports them).
-- accuracy_m is the phone's own estimate of how far off the
-- point may be; the map skips the badly placed ones.
-- ------------------------------------------------------------
create table if not exists public.location_points (
  user_id      uuid        not null references public.users(id),
  recorded_at  timestamptz not null,
  latitude     double precision not null,
  longitude    double precision not null,
  accuracy_m   real,
  speed_mps    real,
  primary key (user_id, recorded_at),
  constraint location_points_latitude_range  check (latitude  between -90  and 90),
  constraint location_points_longitude_range check (longitude between -180 and 180)
);

comment on table public.location_points is
  'Planning: the route a salesman''s device drove, one GPS point per ~150 m, working hours only. Written by the phone, read by managers.';


-- ------------------------------------------------------------
-- 2. Who may see and write what
--
-- A device writes points for whoever is signed in on it, and
-- nobody else. A manager (current_role_is('manager') counts an
-- admin too) reads everyone's; a salesman can read their own,
-- so nothing is recorded about a person that the person
-- themselves cannot see.
--
-- No update and no delete policy: a route is not corrected
-- after the fact.
-- ------------------------------------------------------------
alter table public.location_points enable row level security;
alter table public.location_points force row level security;

drop policy if exists "read location points" on public.location_points;
create policy "read location points"
  on public.location_points for select to authenticated
  using (public.current_role_is('manager') or user_id = public.current_app_user_id());

drop policy if exists "log own location" on public.location_points;
create policy "log own location"
  on public.location_points for insert to authenticated
  with check (user_id = public.current_app_user_id());

-- Supabase grants every new table ALL to anon and authenticated
-- by default, and TRUNCATE is not stopped by row level security.
-- Take everything back and hand out only reading and adding.
revoke all on public.location_points from anon, authenticated;
grant select, insert on public.location_points to authenticated;


-- ------------------------------------------------------------
-- 3. The working window, in one place
--
-- The phone asks this when it starts tracking and records only
-- between these hours on the device's clock. To change the
-- hours, change the two numbers and run this block again —
-- every device picks it up next time it opens, without an app
-- update. end_hour 12 means up to 12:00 noon; 24 would mean
-- up to midnight.
-- ------------------------------------------------------------
create or replace function public.location_tracking_hours()
returns table (start_hour int, end_hour int)
language sql
stable
security invoker
set search_path = public
as $$
  select 5, 24;
$$;

revoke all on function public.location_tracking_hours() from public, anon;
grant execute on function public.location_tracking_hours() to authenticated;


-- ------------------------------------------------------------
-- 4. How the phone sends a batch
--
-- One call per batch, stamped with the signed-in person's id by
-- the database rather than by the phone — a device cannot write
-- somebody else's route even by mistake. Points already stored
-- are skipped. Returns how many were new.
--
-- SECURITY INVOKER: it runs as the caller, so the insert policy
-- above still decides.
-- ------------------------------------------------------------
create or replace function public.log_location_points(p_points jsonb)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  me uuid := public.current_app_user_id();
  added int;
begin
  if me is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if jsonb_typeof(p_points) <> 'array' then
    raise exception 'p_points must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_points) > 1000 then
    raise exception 'At most 1,000 points per call' using errcode = '22023';
  end if;

  insert into public.location_points (user_id, recorded_at, latitude, longitude, accuracy_m, speed_mps)
  select me,
         (p->>'recorded_at')::timestamptz,
         (p->>'latitude')::double precision,
         (p->>'longitude')::double precision,
         nullif(p->>'accuracy_m', '')::real,
         nullif(p->>'speed_mps', '')::real
    from jsonb_array_elements(p_points) as p
   -- A clock far in the future is a broken device, not a route.
   where (p->>'recorded_at')::timestamptz <= now() + interval '10 minutes'
  on conflict (user_id, recorded_at) do nothing;

  get diagnostics added = row_count;
  return added;
end;
$$;

revoke all on function public.log_location_points(jsonb) from public, anon;
grant execute on function public.log_location_points(jsonb) to authenticated;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'location_points table' as item,
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='location_points')
            then 'OK' else 'MISSING' end as status
union all
select 'row level security forced',
       case when (select relrowsecurity and relforcerowsecurity from pg_class
                   where oid = 'public.location_points'::regclass)
            then 'OK' else 'NOT FORCED' end
union all
select 'recorded_at is timestamptz',
       case when (select data_type from information_schema.columns
                   where table_schema='public' and table_name='location_points'
                     and column_name='recorded_at') = 'timestamp with time zone'
            then 'OK' else 'WRONG TYPE' end
union all
select 'anon cannot read',
       case when not has_table_privilege('anon', 'public.location_points', 'select')
            then 'OK' else 'ANON CAN READ' end
union all
select 'working hours function',
       case when exists (select 1 from pg_proc where proname = 'location_tracking_hours')
            then 'OK' else 'MISSING' end
union all
select 'batch upload function',
       case when exists (select 1 from pg_proc where proname = 'log_location_points')
            then 'OK' else 'MISSING' end;
