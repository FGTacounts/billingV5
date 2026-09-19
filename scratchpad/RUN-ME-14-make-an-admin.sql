-- ============================================================
-- FGT Billing — give someone an admin account.
--
-- TWO STEPS. Do step 1 in the dashboard, then run step 2 here.
--
-- STEP 1 — create the login (Supabase Dashboard)
--
--   Authentication -> Users -> Add user -> Create new user
--     Email:             <username>@fgtbilling.internal
--                        e.g. bilal@fgtbilling.internal
--                        The app signs in by username and builds
--                        this address itself, so it is not a real
--                        mailbox and must not be a real one.
--     Password:          pick one and tell them
--     Auto Confirm User: ON   <- without this they cannot sign in
--
-- STEP 2 — give that login its place in the app (this file)
--
--   Change the three values marked below and run the whole file.
--   It finds the login you just made by its address, so you never
--   copy a UUID by hand.
--
-- Safe to run more than once: it updates the same person rather
-- than creating a second one.
-- ============================================================

-- ---------------- change these three ----------------
--   :email  the address you typed in step 1
--   :name   the name that shows on screen
--   :role   'admin' | 'manager' | 'salesman' | 'warehouse'
-- ----------------------------------------------------

-- 1 of 2 — if this person already has a staff row, correct it.
update public.users u
   set role      = 'admin',                         -- <= role
       full_name = 'Bilal Ajnaz',                   -- <= name
       is_active = true
  from auth.users a
 where a.email = 'bilal@fgtbilling.internal'        -- <= email
   and u.auth_user_id = a.id;

-- 2 of 2 — if they do not, create it.
insert into public.users (auth_user_id, username, full_name, role, is_active)
select a.id,
       split_part(a.email, '@', 1),                 -- username = before the @
       'Bilal Ajnaz',                               -- <= name
       'admin',                                     -- <= role
       true
  from auth.users a
 where a.email = 'bilal@fgtbilling.internal'        -- <= email
   and not exists (select 1 from public.users u where u.auth_user_id = a.id);


-- ------------------------------------------------------------
-- Check it worked. The person should be listed, with their role,
-- and "linked" in the last column. Anyone showing
-- "NO LOGIN" has a staff row but no way to sign in — redo step 1
-- for them with exactly the address shown.
-- ------------------------------------------------------------
select u.username,
       u.full_name,
       u.role,
       u.is_active,
       coalesce(a.email, u.username || '@fgtbilling.internal') as sign_in_address,
       case when a.id is null then 'NO LOGIN — redo step 1' else 'linked' end as login
  from public.users u
  left join auth.users a on a.id = u.auth_user_id
 order by u.role, u.full_name;
