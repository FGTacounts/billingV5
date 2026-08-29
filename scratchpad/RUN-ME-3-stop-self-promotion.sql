-- ============================================================
-- FGT Billing — stop a user promoting themselves.
-- Paste into Supabase -> SQL Editor -> Run.
--
-- Safe to run more than once.
--
-- IMPORTANT: run this before anyone outside your own team uses
-- the app.
--
-- What it fixes: a salesman signed in to the app could send a
-- request straight to the database and set their own role to
-- manager. Nothing in the app offers this, but the app is not
-- what was stopping them — the database was allowing it. A
-- manager can see cost prices and stock, and approve orders.
-- The same hole let them set their own sales goal to any figure
-- they liked.
--
-- Tested on 29 Aug 2026 against the live database, signed in as
-- a real salesman account: both changes went through, and were
-- put straight back.
-- ============================================================

-- Row-level rules decide WHICH rows you may touch, not which
-- columns. A user is allowed to edit their own row — reasonably,
-- for their own name or phone — and that same permission let them
-- edit the fields that decide what they are allowed to do.
--
-- This closes the gap at the column level: the sensitive fields
-- may only be changed by a manager, on any row, including one's
-- own.
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
     or new.auth_user_id   is distinct from old.auth_user_id
     or new.monthly_target is distinct from old.monthly_target then
    raise exception
      'Only a manager can change a role, access, username or sales goal';
  end if;

  return new;
end $$;

drop trigger if exists guard_user_privileged_columns on public.users;

create trigger guard_user_privileged_columns
  before update on public.users
  for each row
  execute function public.guard_user_privileged_columns();


-- ------------------------------------------------------------
-- Check it worked. Expect one row, saying OK.
-- ------------------------------------------------------------
select 'self-promotion blocked' as item,
       case when exists (
              select 1 from pg_trigger
               where tgname = 'guard_user_privileged_columns'
                 and tgrelid = 'public.users'::regclass
            ) then 'OK' else 'MISSING' end as status;
