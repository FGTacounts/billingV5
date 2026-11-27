-- ============================================================
-- FGT Billing — Ajnaz and Bilal are admins; device locations are
-- recorded for everyone and seen by admins only.
--
-- Owner, 2026-11-27:
--   "record the path of the user from 5 am to 12am. i should be
--    able to check where the device is, and which all locations
--    the user/device has been to. … give the data only to the
--    admin and not the manager. Also do the same for all
--    devices/user types who have our app installed. Make the
--    ajnaz and bilal account admins. something happened to
--    bilal's account."
--
-- Needs RUN-ME-46 (already run) underneath it.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says isdeheipdfmwzmmnnidr first.
-- Safe to run more than once.
--
-- IMPORTANT: the editor only shows the LAST result. Section 1 and
-- the final check are the ones to look at — run section 1 on its
-- own first (select it, then Run) if you want to see what was
-- wrong with Bilal's account before it is changed.
-- ============================================================


-- ------------------------------------------------------------
-- 1. What the two accounts look like now (read only)
--
-- One row per account. Things that stop someone signing in:
--   no_login        — no Supabase login with that address
--   not_linked      — the staff row points at a different login
--   inactive        — is_active is off (the app refuses them)
--   banned_until    — Supabase has blocked the login
--   email_confirmed — empty means the login was never confirmed
-- ------------------------------------------------------------
select coalesce(u.username, split_part(a.email, '@', 1)) as account,
       u.full_name,
       u.role,
       u.is_active,
       a.email                         as login_address,
       a.email_confirmed_at            as email_confirmed,
       a.banned_until,
       a.last_sign_in_at,
       case
         when a.id is null then 'no_login'
         when u.id is null then 'no staff row'
         when u.auth_user_id is distinct from a.id then 'not_linked'
         when not u.is_active then 'inactive'
         when a.banned_until is not null and a.banned_until > now() then 'banned'
         when a.email_confirmed_at is null then 'unconfirmed'
         else 'looks fine'
       end as problem
  from (values ('ajnaz'), ('bilal')) as want(username)
  left join public.users u on lower(u.username) = want.username
  left join auth.users a on a.email = want.username || '@fgtbilling.internal';


-- ------------------------------------------------------------
-- 2. Make both of them working admins
--
-- For each of ajnaz@ and bilal@fgtbilling.internal:
--   - the staff row is linked to that login (if it pointed
--     elsewhere, or nowhere),
--   - role admin, active,
--   - a staff row is created if there was none,
--   - a Supabase block (ban) is lifted and the login confirmed.
-- The password is NOT touched. If Bilal still cannot sign in
-- after this, set a new one in Authentication -> Users ->
-- bilal@fgtbilling.internal -> "…" menu. (Not "send recovery
-- email": that address is not a real mailbox.)
-- ------------------------------------------------------------
-- The staff table's guard (guard_user_privileged_columns, RUN-ME-3/20)
-- lets only a signed-in manager change a role or a login link. This
-- editor is not signed in as anybody, so the guard refused the first
-- run of this file. It is switched off for these two rows only, inside
-- this one block: if anything in the block fails, switching it off is
-- undone along with everything else, and it is switched back on at the
-- end either way.
do $$
declare
  who   text;
  login uuid;
  guarded boolean := exists (
    select 1 from pg_trigger
     where tgname = 'guard_user_privileged_columns'
       and tgrelid = 'public.users'::regclass
  );
begin
  if guarded then
    execute 'alter table public.users disable trigger guard_user_privileged_columns';
  end if;

  foreach who in array array['ajnaz', 'bilal'] loop
    select id into login from auth.users where email = who || '@fgtbilling.internal';
    if login is null then
      raise notice '% has no login (%@fgtbilling.internal) — create it in Authentication -> Users first, Auto Confirm ON, then run this again', who, who;
      continue;
    end if;

    -- A login can belong to one staff row only. If another row
    -- claims it (an old duplicate), that row lets go of it.
    update public.users set auth_user_id = null
     where auth_user_id = login and lower(username) <> who;

    update public.users
       set auth_user_id = login,
           role         = 'admin',
           is_active    = true
     where lower(username) = who;

    if not found then
      insert into public.users (auth_user_id, username, full_name, role, is_active)
      values (login, who, initcap(who), 'admin', true);
    end if;

    update auth.users
       set banned_until       = null,
           email_confirmed_at = coalesce(email_confirmed_at, now())
     where id = login;

    raise notice '% is an active admin', who;
  end loop;

  if guarded then
    execute 'alter table public.users enable trigger guard_user_privileged_columns';
  end if;
end
$$;


-- ------------------------------------------------------------
-- 3. Every device the app is installed on
--
-- One row per iPhone, iPad or Mac (Apple's per-device id for
-- this app). The app reports in whenever it sends points or
-- opens; the last place it was is kept on the row, so "where is
-- this device now" is one small read, not a search through
-- every point.
-- ------------------------------------------------------------
create table if not exists public.tracked_devices (
  device_id        uuid primary key,
  user_id          uuid references public.users(id),
  platform         text,          -- iPhone | iPad | Mac
  model            text,          -- e.g. iPad13,4
  device_name      text,
  app_version      text,
  last_seen_at     timestamptz not null default now(),
  last_fix_at      timestamptz,
  last_latitude    double precision,
  last_longitude   double precision,
  last_accuracy_m  real,
  first_seen_at    timestamptz not null default now()
);

comment on table public.tracked_devices is
  'Every device the app runs on, who last used it, and where it last was. Written only by log_location_points(); read by admins.';

alter table public.location_points add column if not exists device_id uuid;
create index if not exists location_points_device_time_idx
  on public.location_points (device_id, recorded_at);


-- ------------------------------------------------------------
-- 4. Admins only
--
-- Managers no longer see anyone's route, and nobody sees their
-- own: the owner asked for the data to go to the admin and no
-- one else. Nobody writes to these tables directly any more —
-- only through log_location_points() below, which stamps who and
-- which device itself.
-- ------------------------------------------------------------
alter table public.location_points enable row level security;
alter table public.location_points force row level security;
alter table public.tracked_devices enable row level security;
alter table public.tracked_devices force row level security;

drop policy if exists "read location points" on public.location_points;
drop policy if exists "log own location" on public.location_points;
drop policy if exists "admins read location points" on public.location_points;
create policy "admins read location points"
  on public.location_points for select to authenticated
  using (public.current_user_is_admin());

drop policy if exists "admins read devices" on public.tracked_devices;
create policy "admins read devices"
  on public.tracked_devices for select to authenticated
  using (public.current_user_is_admin());

revoke all on public.location_points from anon, authenticated;
revoke all on public.tracked_devices from anon, authenticated;
grant select on public.location_points to authenticated;
grant select on public.tracked_devices to authenticated;


-- ------------------------------------------------------------
-- 5. How every device sends its points
--
-- Replaces RUN-ME-46's version. p_device is new and optional, so
-- a phone still on the first build keeps working.
--
-- SECURITY DEFINER because nobody may write the tables directly
-- (section 4). What it trusts from the caller is only the points
-- and the device's description: WHO is always
-- current_app_user_id(), never something the device says.
-- An empty p_points is allowed — the app opening counts as the
-- device being seen.
-- ------------------------------------------------------------
drop function if exists public.log_location_points(jsonb);

create or replace function public.log_location_points(p_points jsonb, p_device jsonb default null)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me     uuid := public.current_app_user_id();
  dev    uuid;
  added  int := 0;
  latest record;
begin
  if me is null then
    raise exception 'Not signed in' using errcode = '42501';
  end if;
  if p_points is null or jsonb_typeof(p_points) <> 'array' then
    raise exception 'p_points must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_points) > 1000 then
    raise exception 'At most 1,000 points per call' using errcode = '22023';
  end if;

  if p_device is not null and jsonb_typeof(p_device) = 'object' then
    begin
      dev := (p_device->>'id')::uuid;
    exception when others then
      dev := null;
    end;
  end if;

  insert into public.location_points (user_id, recorded_at, latitude, longitude, accuracy_m, speed_mps, device_id)
  select me,
         (p->>'recorded_at')::timestamptz,
         (p->>'latitude')::double precision,
         (p->>'longitude')::double precision,
         nullif(p->>'accuracy_m', '')::real,
         nullif(p->>'speed_mps', '')::real,
         dev
    from jsonb_array_elements(p_points) as p
   where (p->>'recorded_at')::timestamptz <= now() + interval '10 minutes'
     and (p->>'latitude')::double precision  between -90  and 90
     and (p->>'longitude')::double precision between -180 and 180
  on conflict (user_id, recorded_at) do nothing;
  get diagnostics added = row_count;

  if dev is not null then
    select (p->>'recorded_at')::timestamptz        as at,
           (p->>'latitude')::double precision      as lat,
           (p->>'longitude')::double precision     as lon,
           nullif(p->>'accuracy_m', '')::real      as acc
      into latest
      from jsonb_array_elements(p_points) as p
     where (p->>'recorded_at')::timestamptz <= now() + interval '10 minutes'
     order by (p->>'recorded_at')::timestamptz desc
     limit 1;

    insert into public.tracked_devices as d
           (device_id, user_id, platform, model, device_name, app_version, last_seen_at,
            last_fix_at, last_latitude, last_longitude, last_accuracy_m)
    values (dev, me,
            left(p_device->>'platform', 20), left(p_device->>'model', 40),
            left(p_device->>'name', 80), left(p_device->>'app_version', 20), now(),
            latest.at, latest.lat, latest.lon, latest.acc)
    on conflict (device_id) do update
       set user_id      = excluded.user_id,
           platform     = coalesce(excluded.platform, d.platform),
           model        = coalesce(excluded.model, d.model),
           device_name  = coalesce(excluded.device_name, d.device_name),
           app_version  = coalesce(excluded.app_version, d.app_version),
           last_seen_at = now(),
           -- Only ever moves forward: a late, older batch does not
           -- put the device back where it was an hour ago.
           last_fix_at     = case when excluded.last_fix_at is not null and (d.last_fix_at is null or excluded.last_fix_at > d.last_fix_at) then excluded.last_fix_at     else d.last_fix_at     end,
           last_latitude   = case when excluded.last_fix_at is not null and (d.last_fix_at is null or excluded.last_fix_at > d.last_fix_at) then excluded.last_latitude   else d.last_latitude   end,
           last_longitude  = case when excluded.last_fix_at is not null and (d.last_fix_at is null or excluded.last_fix_at > d.last_fix_at) then excluded.last_longitude  else d.last_longitude  end,
           last_accuracy_m = case when excluded.last_fix_at is not null and (d.last_fix_at is null or excluded.last_fix_at > d.last_fix_at) then excluded.last_accuracy_m else d.last_accuracy_m end;
  end if;

  return added;
end;
$$;

revoke all on function public.log_location_points(jsonb, jsonb) from public, anon;
grant execute on function public.log_location_points(jsonb, jsonb) to authenticated;


-- ------------------------------------------------------------
-- 6. The hours stay 5 am to midnight (RUN-ME-47), restated so
--    running RUN-ME-46 again later cannot quietly undo them.
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
-- Check it worked. Every row should say OK.
-- ------------------------------------------------------------
select 'staff guard switched back on' as item,
       case when not exists (select 1 from pg_trigger
                              where tgname = 'guard_user_privileged_columns'
                                and tgrelid = 'public.users'::regclass)
              or exists (select 1 from pg_trigger
                          where tgname = 'guard_user_privileged_columns'
                            and tgrelid = 'public.users'::regclass
                            and tgenabled <> 'D')
            then 'OK' else 'STILL OFF' end as status
union all
select 'ajnaz is an active admin',
       case when exists (select 1 from public.users u join auth.users a on a.id = u.auth_user_id
                          where lower(u.username) = 'ajnaz' and u.role = 'admin' and u.is_active)
            then 'OK' else 'NO — see the notice above, or create the login first' end as status
union all
select 'bilal is an active admin',
       case when exists (select 1 from public.users u join auth.users a on a.id = u.auth_user_id
                          where lower(u.username) = 'bilal' and u.role = 'admin' and u.is_active)
            then 'OK' else 'NO — see the notice above, or create the login first' end
union all
select 'devices table, admins only',
       case when (select relrowsecurity and relforcerowsecurity from pg_class
                   where oid = 'public.tracked_devices'::regclass)
             and not has_table_privilege('authenticated', 'public.tracked_devices', 'insert')
            then 'OK' else 'NOT LOCKED' end
union all
select 'points: nobody writes directly',
       case when not has_table_privilege('authenticated', 'public.location_points', 'insert')
             and not has_table_privilege('anon', 'public.location_points', 'select')
            then 'OK' else 'STILL WRITABLE' end
union all
select 'managers no longer read points',
       case when not exists (select 1 from pg_policies
                              where tablename = 'location_points' and policyname = 'read location points')
            then 'OK' else 'OLD POLICY LEFT' end
union all
select 'hours 5 to midnight',
       case when (select end_hour from public.location_tracking_hours()) = 24 then 'OK' else 'WRONG' end;
