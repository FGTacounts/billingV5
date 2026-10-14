-- ============================================================
-- UNDO for RUN-ME-37 — run in project FALCON only, never in the
-- billing project (isdeheipdfmwzmmnnidr).
--
-- RUN-ME-37 was run in Falcon by mistake on 2026-10-14. It added
-- orders.payment_terms and the check constraint
-- orders_payment_terms_length to Falcon's orders table.
--
-- The constraint is removed outright (its name is ours). The
-- column is removed ONLY if it is safe to say we added it:
--   • it is the newest column on the table (added last), and
--   • not one order has anything in it.
-- If Falcon already had its own payment_terms column, one of those
-- is false and the column is left alone, with a notice saying why.
-- ============================================================

alter table public.orders
  drop constraint if exists orders_payment_terms_length;

do $$
declare
  v_is_newest boolean;
  v_filled bigint;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'orders'
       and column_name = 'payment_terms'
  ) then
    raise notice 'No payment_terms column on orders — nothing to undo.';
    return;
  end if;

  select a.attnum = (select max(b.attnum) from pg_attribute b
                      where b.attrelid = 'public.orders'::regclass
                        and b.attnum > 0 and not b.attisdropped)
    into v_is_newest
    from pg_attribute a
   where a.attrelid = 'public.orders'::regclass
     and a.attname = 'payment_terms';

  execute 'select count(*) from public.orders where payment_terms is not null'
    into v_filled;

  if v_is_newest and v_filled = 0 then
    alter table public.orders drop column payment_terms;
    raise notice 'Removed orders.payment_terms (empty, added last).';
  else
    raise notice 'Left orders.payment_terms alone: newest column = %, orders with a value = %. It may be Falcon''s own.',
      v_is_newest, v_filled;
  end if;
end $$;

notify pgrst, 'reload schema';

-- Proof. Expect no rows.
select column_name
  from information_schema.columns
 where table_schema = 'public' and table_name = 'orders'
   and column_name = 'payment_terms'
union all
select conname::text
  from pg_constraint
 where conname = 'orders_payment_terms_length';
