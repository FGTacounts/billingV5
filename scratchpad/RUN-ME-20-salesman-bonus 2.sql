-- ============================================================
-- FGT Billing — a salesman's monthly bonus and incentive note.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- Why: the phone has kept three figures per salesman per month
-- since V5 — the monthly target, a bonus, and a special-offer
-- note (GoalsStore.swift). Only the target was ever synced; the
-- bonus and the note lived in UserDefaults on whichever handset
-- typed them, so a manager who set a bonus on one device could
-- not see it on another and the web could not see it at all.
-- These two columns give them the same home the target already
-- has, next to it on `users`, so the one sync path carries all
-- three.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The two figures
--
-- Both nullable with no default, and null is meaningful: no
-- bonus set for this salesman, no offer running. Bonus is the
-- same shape as users.monthly_target — AED, numeric, not a
-- float — so the two are read, summed and displayed the same
-- way with no conversion between them.
-- ------------------------------------------------------------
alter table public.users
  add column if not exists monthly_bonus numeric(14, 2);

comment on column public.users.monthly_bonus is
  'This salesman''s monthly bonus in AED, set by a manager. Null = no bonus.';

alter table public.users
  add column if not exists incentive_note text;

comment on column public.users.incentive_note is
  'Free-text special offer / incentive for this salesman, set by a manager. Null or empty = none.';


-- ------------------------------------------------------------
-- 2. A bonus is never negative
--
-- Same guard the target already carries
-- (users_monthly_target_nonneg, sales-targets-migration.sql).
-- Zero is allowed and is not the same as null: zero is "the
-- manager looked and set none this month".
-- ------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_monthly_bonus_nonneg') then
    alter table public.users
      add constraint users_monthly_bonus_nonneg
      check (monthly_bonus is null or monthly_bonus >= 0);
  end if;
end $$;


-- ------------------------------------------------------------
-- 3. Only a manager may set them
--
-- Row rules decide which rows you may touch, not which columns,
-- and a user may edit their own row. Without this a salesman
-- could send one request to the database and award themselves a
-- bonus, exactly as they could once set their own sales goal.
--
-- This is RUN-ME-3's guard with the two new columns added to the
-- same list; nothing else about it changes. Running RUN-ME-3
-- again afterwards would drop the two new names from the list,
-- so run this one last.
-- ------------------------------------------------------------
create or replace function public.guard_user_privileged_columns()
returns trigger
language plpgsql
-- Deliberately NOT security definer: this needs to see who is
-- really calling, so that the server's own admin key still works.
as $$
begin
  -- The server's admin key, used by the app's own user-management
  -- screen, is trusted and passes straight through.
  if current_user = 'service_role' then
    return new;
  end if;

  if public.current_role_is('manager') then
    return new;
  end if;

  if new.role         is distinct from old.role
     or new.is_active is distinct from old.is_active
     or new.username  is distinct from old.username
     or new.auth_user_id    is distinct from old.auth_user_id
     or new.monthly_target  is distinct from old.monthly_target
     or new.monthly_bonus   is distinct from old.monthly_bonus
     or new.incentive_note  is distinct from old.incentive_note then
    raise exception
      'Only a manager can change a role, access, username, sales goal, bonus or incentive';
  end if;

  return new;
end $$;

drop trigger if exists guard_user_privileged_columns on public.users;

create trigger guard_user_privileged_columns
  before update on public.users
  for each row
  execute function public.guard_user_privileged_columns();


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'users.monthly_bonus' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='users'
                            and column_name='monthly_bonus')
            then 'OK' else 'MISSING' end as status
union all
select 'users.incentive_note',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='users'
                            and column_name='incentive_note')
            then 'OK' else 'MISSING' end
union all
select 'bonus is never negative',
       case when exists (select 1 from pg_constraint
                          where conname = 'users_monthly_bonus_nonneg')
            then 'OK' else 'MISSING' end
union all
select 'only a manager may set them',
       case when exists (
              select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname = 'guard_user_privileged_columns'
                and pg_get_functiondef(p.oid) like '%monthly_bonus%'
                and pg_get_functiondef(p.oid) like '%incentive_note%')
            then 'OK' else 'MISSING' end
union all
select 'guard is attached to users',
       case when exists (
              select 1 from pg_trigger
               where tgname = 'guard_user_privileged_columns'
                 and tgrelid = 'public.users'::regclass)
            then 'OK' else 'MISSING' end;
