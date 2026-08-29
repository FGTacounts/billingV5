-- ============================================================
-- FGT Billing — let a manager set a salesman's monthly goal.
-- Paste into Supabase -> SQL Editor -> Run.
--
-- Safe to run more than once.
--
-- Why this is needed: the goal boxes in Settings -> Users saved
-- nothing. The database was declining the change, but a declined
-- change is not reported as an error — the row simply does not
-- move — so the screen said "Goal saved." and the goal stayed
-- blank. The app now notices and says so; this grants the
-- permission so it succeeds instead.
-- ============================================================

-- Only a manager or admin may change another user's row, and this
-- is written as its own policy so it grants nothing else: it does
-- not open up who can read the table, and it does not let a
-- salesman edit anybody, including themselves.
drop policy if exists "managers update users" on public.users;

create policy "managers update users"
  on public.users
  for update
  to authenticated
  using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

-- current_role_is('manager') is true for admins too, so both roles
-- that run the business are covered.


-- ------------------------------------------------------------
-- Check it worked. Expect one row, saying OK.
-- ------------------------------------------------------------
select 'managers can update users' as item,
       case when exists (
              select 1 from pg_policies
               where schemaname = 'public'
                 and tablename  = 'users'
                 and policyname = 'managers update users'
            ) then 'OK' else 'MISSING' end as status;
