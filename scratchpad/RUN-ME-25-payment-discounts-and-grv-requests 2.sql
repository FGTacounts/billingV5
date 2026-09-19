-- ============================================================
-- FGT Billing — a discount and a goods return typed while
-- collecting a payment become real figures, not a sentence.
--
-- Until now both apps wrote "Discount applied by …" and "GRV
-- credit applied: …" into payments.notes and nothing else. No
-- invoice ever came down by either amount, so the customer kept
-- owing money the collector had already agreed to let go, and a
-- return claimed at the door never reached the manager.
--
-- This gives both figures a home:
--
--   • payments.discount_amount — what the manager let go on that
--     collection. The per-invoice slices in payment_orders now
--     carry cash + discount, oldest selected invoice first, so
--     every screen that ages a balance sees it without changing.
--
--   • grv_returns.amount / payment_id / notes — a return claimed
--     while collecting is raised as a PENDING request for that
--     amount, already carrying the customer. A manager opens it,
--     enters the products that came back, and approves it; only
--     then does the amount come off what the customer owes.
--     `amount` is what the customer is credited (VAT included,
--     because it is set against invoice totals). A return logged
--     the old way has no amount and is still valued from its
--     lines, exactly as before.
--
--   • Managers and admins may now correct a return after it has
--     been entered: change or remove its lines, and remove a
--     request that should never have been raised. There was no
--     policy allowing either, so a typing mistake was permanent.
--
-- Both apps work before this is run — they fall back to the old
-- note-only behaviour for the GRV request and leave the discount
-- column out — but the figures only become real once it has.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The discount given on a collection
-- ------------------------------------------------------------
alter table public.payments
  add column if not exists discount_amount numeric not null default 0;

alter table public.payments
  drop constraint if exists payments_discount_not_negative;
alter table public.payments
  add constraint payments_discount_not_negative check (discount_amount >= 0);

comment on column public.payments.discount_amount is
  'Discount a manager gave on this collection. payment_orders slices carry amount + discount_amount.';


-- ------------------------------------------------------------
-- 2. A return claimed while collecting
--
-- payment_id is "set null" on delete: removing a payment must
-- not take a goods return with it — the goods still came back.
-- ------------------------------------------------------------
alter table public.grv_returns
  add column if not exists amount     numeric,
  add column if not exists payment_id uuid references public.payments(id) on delete set null,
  add column if not exists notes      text;

alter table public.grv_returns
  drop constraint if exists grv_returns_amount_not_negative;
alter table public.grv_returns
  add constraint grv_returns_amount_not_negative check (amount is null or amount >= 0);

comment on column public.grv_returns.amount is
  'Credit given for this return, VAT included. Null = value it from grv_items (returns logged before 2026-09-18).';

create index if not exists grv_returns_customer_status_idx
  on public.grv_returns (customer_id, status);
create index if not exists grv_returns_payment_idx
  on public.grv_returns (payment_id) where payment_id is not null;
create index if not exists grv_items_grv_idx
  on public.grv_items (grv_id);


-- ------------------------------------------------------------
-- 3. Who may correct a return
--
-- Raising one stays open to everyone signed in (RUN-ME-13).
-- Changing lines, and removing a request, is for a manager —
-- current_role_is('manager') already counts an admin.
-- ------------------------------------------------------------
drop policy if exists "correct return lines" on public.grv_items;
create policy "correct return lines" on public.grv_items
  for update to authenticated
  using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

drop policy if exists "remove return lines" on public.grv_items;
create policy "remove return lines" on public.grv_items
  for delete to authenticated
  using (public.current_role_is('manager'));

drop policy if exists "remove returns" on public.grv_returns;
create policy "remove returns" on public.grv_returns
  for delete to authenticated
  using (public.current_role_is('manager'));

-- A payment's slices are re-cut when the payment is edited. Insert
-- and delete were already allowed (RUN-ME-13); nothing new needed.


-- ------------------------------------------------------------
-- 4. Confirm
-- ------------------------------------------------------------
select 'payments.discount_amount' as added,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'payments'
                  and column_name = 'discount_amount') as present
union all
select 'grv_returns.amount',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'grv_returns'
                  and column_name = 'amount')
union all
select 'grv_items delete policy',
       exists (select 1 from pg_policies
                where schemaname = 'public' and tablename = 'grv_items'
                  and policyname = 'remove return lines');
