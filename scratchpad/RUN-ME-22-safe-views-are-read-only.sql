-- ============================================================
-- SUPERSEDED BY RUN-ME-24. This file is correct as far as it
-- goes but does not finish the job: the privilege is held by
-- PUBLIC, not by anon, and revoking from a role that merely
-- inherits it takes nothing away. Run RUN-ME-24 instead; it is
-- safe whether or not this one was run.
-- ============================================================
-- FGT Billing — the two "safe" views are for reading, and the
-- database should say so.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. It grants nothing; it only takes
-- away access that was never used.
--
-- WHY
--
-- `npm run test:tenancy` found that an anonymous caller holding
-- the app's public key gets a different answer from the two
-- safe views when it tries to write:
--
--   products_safe      permission denied          (correct)
--   order_items_safe   "cannot insert into view"  (got past
--                       the permission check)
--
-- The second reply means the INSERT privilege is actually there.
-- Nothing can be written through it today, because the view has
-- no INSTEAD OF trigger and is not auto-updatable — which is the
-- only reason this has been harmless.
--
-- It should still go, for two reasons. A privilege nobody uses
-- is one nobody is watching. And both views deliberately run as
-- their OWNER rather than as the reader (RUN-ME-15 set
-- security_invoker = false, so that staff who are not granted
-- products.cost can still be handed a masked version of it) —
-- so if either view ever becomes writable, a write through it
-- would run with the owner's rights, not the caller's.
--
-- Neither app writes through either view. Verified across the
-- web app and the phone: every reference is a SELECT.
-- ------------------------------------------------------------

revoke insert, update, delete, truncate
  on public.order_items_safe
  from anon, authenticated;

revoke insert, update, delete, truncate
  on public.products_safe
  from anon, authenticated;

-- Reading is the point of them, and that stays exactly as it is.
grant select on public.order_items_safe to authenticated;
grant select on public.products_safe    to authenticated;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
--
-- `has_table_privilege` answers for the named role directly, so
-- this is the same question the tenancy check asks over HTTP.
-- ------------------------------------------------------------
select 'order_items_safe: anon cannot insert' as item,
       case when not has_table_privilege('anon', 'public.order_items_safe', 'INSERT')
            then 'OK' else 'STILL GRANTED' end as status
union all
select 'order_items_safe: authenticated cannot insert',
       case when not has_table_privilege('authenticated', 'public.order_items_safe', 'INSERT')
            then 'OK' else 'STILL GRANTED' end
union all
select 'products_safe: anon cannot insert',
       case when not has_table_privilege('anon', 'public.products_safe', 'INSERT')
            then 'OK' else 'STILL GRANTED' end
union all
select 'order_items_safe: signed-in staff can still read',
       case when has_table_privilege('authenticated', 'public.order_items_safe', 'SELECT')
            then 'OK' else 'READ WAS LOST' end
union all
select 'products_safe: signed-in staff can still read',
       case when has_table_privilege('authenticated', 'public.products_safe', 'SELECT')
            then 'OK' else 'READ WAS LOST' end;
