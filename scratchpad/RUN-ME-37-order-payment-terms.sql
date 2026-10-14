-- ============================================================
-- FGT Billing — payment terms per order.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run,
-- with the role selector on `postgres`. Safe to run more than
-- once. Adds one column to orders; changes no row.
--
-- Owner's request, 2026-10-14: "ability to edit payments terms
-- of specific orders (shows in the pdf)". Every invoice printed
-- the same "INVOICE TO 30 DAYS" under Payment Terms. A manager
-- can now write different terms on one order, and that order's
-- invoice prints them.
--
--   • orders.payment_terms, text, empty for every existing order.
--     Empty means the standard terms, so nothing printed today
--     changes until a manager writes something on an order.
--   • At most 40 characters: the Payment Terms cell on the
--     invoice is a sixth of the page wide, and two short lines
--     is all it holds.
--   • No new policy: who may change an order is decided by the
--     orders policies already there (a manager or admin, as for
--     the PO number). No new table, so nothing new to lock down.
--
-- Adding a column fires no row trigger, so no sale is re-dated.
-- ============================================================

alter table public.orders
  add column if not exists payment_terms text;

alter table public.orders
  drop constraint if exists orders_payment_terms_length;
alter table public.orders
  add constraint orders_payment_terms_length
  check (payment_terms is null or char_length(payment_terms) <= 40);

-- PostgREST learns about the new column straight away.
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Proof. Expect one row: payment_terms | text, and 0 orders
-- with terms set.
-- ------------------------------------------------------------
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'orders'
   and column_name = 'payment_terms';

select count(*) as orders_with_own_terms
  from public.orders
 where payment_terms is not null;
