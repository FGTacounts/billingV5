-- ============================================================
-- FGT Billing — numbered GRVs and credit notes, and a GRV that
-- waits to be ticked at collection (owner, 2026-10-06).
--
-- What the owner asked for:
--   • GRVs and credit notes on the statement as their own lines,
--     numbered GRV100, GRV101 … and CN100, CN101 …, each taking
--     its amount off the total.
--   • A credit note is the discount given while collecting.
--     Only a manager or an admin gives one.
--   • When collecting, the GRV is ticked like an invoice. If the
--     collector leaves it unticked the app asks whether to use it.
--   • Numbers are given on approval, to returns approved from now
--     on. Returns approved before today keep no number and keep
--     coming off the customer's oldest invoices, as they do now.
--
-- This adds:
--
--   1. grv_returns.grv_number — given by the database the moment a
--      return becomes approved (also when it is created already
--      approved). Gap-free: an advisory lock and max()+1, the same
--      way invoice numbers are given, because a sequence does not
--      roll back and leaves gaps.
--
--   2. payments.credit_note_number — given the moment a payment
--      carries a discount. A discount may only be given or changed
--      by a manager or an admin; the database refuses anybody else.
--
--   3. payment_orders.discount_part — how much of each invoice
--      slice was the credit note rather than cash. allocated_amount
--      is unchanged (still cash + discount), so every screen that
--      ages a balance reads exactly what it read yesterday. Null on
--      every slice written before this: those discounts stay inside
--      "Received", as they always have.
--
--   4. grv_allocations — which invoices a numbered GRV was used
--      against, written when it is ticked at collection. A numbered
--      GRV with nothing (or not all of it) allocated is OPEN: it
--      shows on the statement as a minus line and lowers the total
--      until it is ticked. The database refuses an allocation that
--      would use more than the GRV is worth, or one against another
--      customer's invoice, or one on a return that is not approved.
--
-- Both apps keep working before this is run: they ask for the new
-- columns and ask again without them, and every return is treated
-- the old way until it has run.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. GRV numbers, on approval
-- ------------------------------------------------------------
alter table public.grv_returns
  add column if not exists grv_number integer;

create unique index if not exists grv_returns_grv_number_unique
  on public.grv_returns (grv_number)
  where grv_number is not null;

comment on column public.grv_returns.grv_number is
  'GRV100, GRV101 … given on approval from 2026-10-06. Null = approved before then (still credited oldest-invoice-first) or not approved yet.';

create or replace function public.assign_grv_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'approved'
     and new.grv_number is null
     and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    perform pg_advisory_xact_lock(hashtext('famlist_grv_number'));
    select greatest(coalesce(max(g.grv_number), 99) + 1, 100)
      into new.grv_number
      from public.grv_returns g;
  end if;
  return new;
end;
$$;

drop trigger if exists grv_returns_number on public.grv_returns;
create trigger grv_returns_number
  before insert or update of status on public.grv_returns
  for each row execute function public.assign_grv_number();


-- ------------------------------------------------------------
-- 2. Credit note numbers, and who may give a discount
-- ------------------------------------------------------------
alter table public.payments
  add column if not exists credit_note_number integer;

create unique index if not exists payments_credit_note_number_unique
  on public.payments (credit_note_number)
  where credit_note_number is not null;

comment on column public.payments.credit_note_number is
  'CN100, CN101 … — the discount on this collection, numbered from 2026-10-06.';

create or replace function public.assign_credit_note_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Giving or changing a discount is a manager's (or an admin's) act.
  -- current_role_is('manager') already counts an admin. auth.uid() is null
  -- for the SQL editor and the server's own key, which are not refused.
  if coalesce(new.discount_amount, 0) > 0
     and (tg_op = 'INSERT' or new.discount_amount is distinct from old.discount_amount)
     and auth.uid() is not null
     and not public.current_role_is('manager') then
    raise exception 'Only a manager or an admin can give a discount'
      using errcode = '42501';
  end if;

  -- Numbered when the discount is given — on a new collection, or when an
  -- edit changes it. Editing something else on a payment discounted before
  -- 2026-10-06 does not number it: that discount stays inside "Received".
  if coalesce(new.discount_amount, 0) > 0
     and new.credit_note_number is null
     and (tg_op = 'INSERT' or new.discount_amount is distinct from old.discount_amount) then
    perform pg_advisory_xact_lock(hashtext('famlist_credit_note_number'));
    select greatest(coalesce(max(p.credit_note_number), 99) + 1, 100)
      into new.credit_note_number
      from public.payments p;
  end if;
  return new;
end;
$$;

drop trigger if exists payments_credit_note_number on public.payments;
create trigger payments_credit_note_number
  before insert or update of discount_amount on public.payments
  for each row execute function public.assign_credit_note_number();


-- ------------------------------------------------------------
-- 3. The credit note's share of each invoice slice
-- ------------------------------------------------------------
alter table public.payment_orders
  add column if not exists discount_part numeric;

alter table public.payment_orders
  drop constraint if exists payment_orders_discount_part_in_range;
alter table public.payment_orders
  add constraint payment_orders_discount_part_in_range
  check (discount_part is null or (discount_part >= 0 and discount_part <= allocated_amount));

comment on column public.payment_orders.discount_part is
  'How much of allocated_amount is the credit note (discount) rather than cash. Null = written before 2026-10-06.';


-- ------------------------------------------------------------
-- 4. Which invoices a numbered GRV was used against
-- ------------------------------------------------------------
create table if not exists public.grv_allocations (
  id          uuid primary key default gen_random_uuid(),
  grv_id      uuid not null references public.grv_returns(id) on delete restrict,
  order_id    uuid not null references public.orders(id) on delete cascade,
  amount      numeric not null check (amount > 0),
  -- The collection it was ticked on, when there was cash too. A
  -- collection that is nothing but a GRV writes no payment.
  payment_id  uuid references public.payments(id) on delete set null,
  applied_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index if not exists grv_allocations_grv_idx   on public.grv_allocations (grv_id);
create index if not exists grv_allocations_order_idx on public.grv_allocations (order_id);

comment on table public.grv_allocations is
  'A numbered GRV used against an invoice, ticked at collection. Credit not allocated here is open and shows on the statement.';

-- Signed in or nothing (CLAUDE.md rule 3).
alter table public.grv_allocations enable row level security;
alter table public.grv_allocations force row level security;

drop policy if exists "read grv allocations" on public.grv_allocations;
create policy "read grv allocations" on public.grv_allocations
  for select to authenticated using (true);

-- Anyone who may collect may tick a GRV; the trigger below decides
-- whether the tick is sound.
drop policy if exists "use grv at collection" on public.grv_allocations;
create policy "use grv at collection" on public.grv_allocations
  for insert to authenticated with check (true);

-- Un-ticking after the fact puts the credit back to open. A manager's call.
drop policy if exists "release grv allocations" on public.grv_allocations;
create policy "release grv allocations" on public.grv_allocations
  for delete to authenticated using (public.current_role_is('manager'));

create or replace function public.check_grv_allocation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  g          record;
  credit     numeric;
  used       numeric;
  order_cust uuid;
begin
  -- Lock the return so two collectors ticking it at once queue up.
  select r.id, r.customer_id, r.status, r.grv_number, r.amount
    into g
    from public.grv_returns r
   where r.id = new.grv_id
     for update;

  if not found then
    raise exception 'That return does not exist';
  end if;
  if g.status <> 'approved' or g.grv_number is null then
    raise exception 'Only an approved, numbered GRV can be used at collection';
  end if;

  select o.customer_id into order_cust from public.orders o where o.id = new.order_id;
  if order_cust is distinct from g.customer_id then
    raise exception 'A GRV can only be used against its own customer''s invoices';
  end if;

  credit := coalesce(
    g.amount,
    (select sum(i.qty * i.unit_value) from public.grv_items i where i.grv_id = g.id),
    0
  );
  select coalesce(sum(a.amount), 0) into used
    from public.grv_allocations a
   where a.grv_id = g.id;

  if used + new.amount > credit + 0.005 then
    raise exception 'GRV% has only % left to use', g.grv_number, round(credit - used, 2);
  end if;
  return new;
end;
$$;

drop trigger if exists grv_allocations_check on public.grv_allocations;
create trigger grv_allocations_check
  before insert on public.grv_allocations
  for each row execute function public.check_grv_allocation();

-- A manager correcting a GRV's amount cannot take it below what has
-- already been used against invoices.
create or replace function public.check_grv_amount_covers_use()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  used numeric;
begin
  if new.amount is not distinct from old.amount or new.amount is null then
    return new;
  end if;
  select coalesce(sum(a.amount), 0) into used
    from public.grv_allocations a
   where a.grv_id = new.id;
  if new.amount + 0.005 < used then
    raise exception 'GRV% has already been used for %; its amount cannot go below that', new.grv_number, round(used, 2);
  end if;
  return new;
end;
$$;

drop trigger if exists grv_returns_amount_covers_use on public.grv_returns;
create trigger grv_returns_amount_covers_use
  before update of amount on public.grv_returns
  for each row execute function public.check_grv_amount_covers_use();


-- ------------------------------------------------------------
-- 5. Confirm
-- ------------------------------------------------------------
select 'grv_returns.grv_number' as added,
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'grv_returns'
                  and column_name = 'grv_number') as present
union all
select 'payments.credit_note_number',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'payments'
                  and column_name = 'credit_note_number')
union all
select 'payment_orders.discount_part',
       exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'payment_orders'
                  and column_name = 'discount_part')
union all
select 'grv_allocations (RLS forced)',
       exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relname = 'grv_allocations'
                  and c.relrowsecurity and c.relforcerowsecurity);
