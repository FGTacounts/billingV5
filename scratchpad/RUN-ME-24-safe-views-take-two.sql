-- ============================================================
-- FGT Billing — finishing what RUN-ME-22 started.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. It grants nothing new.
--
-- WHY THIS IS A SECOND FILE
--
-- RUN-ME-22 revoked the write privileges on the two "safe"
-- views FROM anon AND authenticated. It ran without error, and
-- it did exactly what it said. The privilege is still there:
--
--   order_items_safe   insert / update / delete all still get
--                      past the permission check
--
-- Because the grant is not held by `anon`. It is held by
-- PUBLIC — the pseudo-role every role in Postgres inherits
-- from, including anon and authenticated. Revoking from a role
-- that is only inheriting the privilege takes nothing away; the
-- grant has to be removed from PUBLIC itself.
--
-- That is a mistake in RUN-ME-22, not in how you ran it.
--
-- Still nothing can be written through either view — both are
-- views with no INSTEAD OF trigger, so Postgres refuses the row
-- on its own. This is about the privilege, which should not be
-- there: both views deliberately run as their OWNER rather than
-- as the reader (RUN-ME-15), so if either ever became writable,
-- a write through it would carry the owner's rights.
--
-- Neither app writes through either view. Every reference on
-- the web and on the phone is a SELECT.
-- ------------------------------------------------------------

-- Take it away from PUBLIC first — that is the one that was
-- missed — and then from the two named roles, in case a direct
-- grant exists as well.
revoke all privileges on public.order_items_safe from public;
revoke all privileges on public.products_safe    from public;

revoke all privileges on public.order_items_safe from anon;
revoke all privileges on public.products_safe    from anon;

revoke all privileges on public.order_items_safe from authenticated;
revoke all privileges on public.products_safe    from authenticated;

-- Reading is the entire point of these two views, and that is
-- given back explicitly to signed-in staff only. `anon` gets
-- nothing: RUN-ME-13 closed that door and it stays closed.
grant select on public.order_items_safe to authenticated;
grant select on public.products_safe    to authenticated;

-- New views and tables in this schema inherit a blanket grant
-- from Supabase's default privileges, which is how this arose in
-- the first place. This stops the next view being born writable.
alter default privileges in schema public
  revoke insert, update, delete, truncate on tables from public;


-- ------------------------------------------------------------
-- Check it worked. Every row should say OK.
--
-- The last two rows print the raw privilege list, so if anything
-- is still there you can see exactly who holds it rather than
-- guessing again.
-- ------------------------------------------------------------
select 'order_items_safe: anon cannot insert' as item,
       case when not has_table_privilege('anon', 'public.order_items_safe', 'INSERT')
            then 'OK' else 'STILL GRANTED' end as status
union all
select 'order_items_safe: anon cannot update',
       case when not has_table_privilege('anon', 'public.order_items_safe', 'UPDATE')
            then 'OK' else 'STILL GRANTED' end
union all
select 'order_items_safe: anon cannot delete',
       case when not has_table_privilege('anon', 'public.order_items_safe', 'DELETE')
            then 'OK' else 'STILL GRANTED' end
union all
select 'products_safe: anon cannot insert',
       case when not has_table_privilege('anon', 'public.products_safe', 'INSERT')
            then 'OK' else 'STILL GRANTED' end
union all
select 'order_items_safe: staff can still read',
       case when has_table_privilege('authenticated', 'public.order_items_safe', 'SELECT')
            then 'OK' else 'READ WAS LOST' end
union all
select 'products_safe: staff can still read',
       case when has_table_privilege('authenticated', 'public.products_safe', 'SELECT')
            then 'OK' else 'READ WAS LOST' end
union all
select 'who holds what on order_items_safe',
       coalesce(array_to_string(c.relacl, ' | '), 'nobody — owner only')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'order_items_safe'
union all
select 'who holds what on products_safe',
       coalesce(array_to_string(c.relacl, ' | '), 'nobody — owner only')
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'products_safe';
