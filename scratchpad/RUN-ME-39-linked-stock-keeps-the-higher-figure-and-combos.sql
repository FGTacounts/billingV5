-- ============================================================
-- FGT Billing — linking two SKUs keeps the higher stock figure,
-- and a product can be a combo of other products.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row.
--
-- Relies on RUN-ME-8 (stock floor), RUN-ME-18 (shared stock) and
-- RUN-ME-29 (current_user_is_admin), all live.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. Linking keeps the higher figure (owner, 2026-11-07)
--
-- Until now the product being added took the figure of the
-- product it joined. Opening a NEW SKU (0 in stock) and adding
-- the ORIGINAL SKU (200 in stock) to it therefore set the
-- original to 0 — the stock disappeared. That is what happened
-- to TSB220/TSB-220 and TTS5053/TTS5053-VC on 2026-11-07.
--
-- Now, when a product joins a shelf, the shelf keeps whichever
-- figure is higher: the shelf's or the product's own. A product
-- with no count kept (null) never lowers or replaces a count.
-- The mirror trigger (RUN-ME-18) then copies the result to every
-- other SKU on the shelf, so the whole shelf agrees.
--
-- A brand-new row inserted straight into a group still takes the
-- group's figure, as before: there is no count of its own to keep.
-- ------------------------------------------------------------
create or replace function public.adopt_shared_stock()
returns trigger
language plpgsql
as $$
declare
  group_stock integer;
begin
  if new.stock_group_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.stock_group_id is not distinct from old.stock_group_id then
    return new;
  end if;
  -- A combo's figure is worked out from its parts (section 2), so
  -- it has no shelf of its own to share.
  if to_regclass('public.product_combo_parts') is not null
     and exists (select 1 from public.product_combo_parts c where c.combo_id = new.id) then
    raise exception 'A combo cannot share stock with another SKU.' using errcode = '23514';
  end if;
  select max(p.stock_on_hand) into group_stock
  from public.products p
  where p.stock_group_id = new.stock_group_id
    and p.id <> new.id;
  if not found or group_stock is null then
    -- Nobody else on the shelf has a count: keep our own.
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.stock_on_hand := group_stock;
  else
    -- greatest() ignores a null, so an uncounted product takes
    -- the shelf's figure and a counted one keeps the higher.
    new.stock_on_hand := greatest(group_stock, new.stock_on_hand);
  end if;
  return new;
end;
$$;


-- ------------------------------------------------------------
-- 2. Combos
--
-- A combo is a product sold as a set of other products: one of
-- each part. It keeps no stock of its own. Its figure is the
-- LOWEST of its parts' figures, because you can only make as
-- many sets as the scarcest part allows (A 200, B 250 -> 200).
--
-- Selling a combo takes one of each part; giving it back (undo
-- an approval, restore, delete) puts one of each back. This is
-- done here rather than in the apps, so every path that already
-- moves stock — the approve and unapprove functions, the phone,
-- the stock route — works for combos without being changed:
-- whatever amount a combo's figure is moved by, each part is
-- moved by the same amount, and the combo's figure is then put
-- back to the lowest part.
-- ------------------------------------------------------------
create table if not exists public.product_combo_parts (
  combo_id   uuid not null references public.products(id) on delete cascade,
  part_id    uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (combo_id, part_id),
  constraint product_combo_parts_not_itself check (combo_id <> part_id)
);

comment on table public.product_combo_parts is
  'A combo product and the products it is made of, one of each. The combo''s stock is the lowest of its parts.';

create index if not exists product_combo_parts_part_idx
  on public.product_combo_parts (part_id);


-- Rule 3: every table has RLS, forced. Anyone signed in may see
-- what a combo is made of (it is not a cost figure: whoever may
-- see the stock may see where it comes from); only a manager or
-- an admin may change it. Nothing for anon.
alter table public.product_combo_parts enable row level security;
alter table public.product_combo_parts force row level security;

revoke all on public.product_combo_parts from anon;
grant select, insert, delete on public.product_combo_parts to authenticated;

drop policy if exists "read combo parts" on public.product_combo_parts;
create policy "read combo parts"
  on public.product_combo_parts for select to authenticated
  using (true);

drop policy if exists "manager adds combo parts" on public.product_combo_parts;
create policy "manager adds combo parts"
  on public.product_combo_parts for insert to authenticated
  with check (public.current_role_is('manager') or public.current_user_is_admin());

drop policy if exists "manager removes combo parts" on public.product_combo_parts;
create policy "manager removes combo parts"
  on public.product_combo_parts for delete to authenticated
  using (public.current_role_is('manager') or public.current_user_is_admin());


-- One level only: a combo is not a part of another combo, a part
-- is not itself a combo, and a combo does not share a shelf with
-- another SKU (its figure is worked out, not counted, so there is
-- no shelf to share). Checked here as well as in the web route,
-- because the phone writes tables directly.
create or replace function public.check_combo_part()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.product_combo_parts c where c.combo_id = new.part_id) then
    raise exception 'A combo cannot be a part of another combo.' using errcode = '23514';
  end if;
  if exists (select 1 from public.product_combo_parts c where c.part_id = new.combo_id) then
    raise exception 'This product is a part of a combo, so it cannot be a combo itself.' using errcode = '23514';
  end if;
  if exists (select 1 from public.products p where p.id = new.combo_id and p.stock_group_id is not null) then
    raise exception 'A product that shares stock with another SKU cannot be a combo. Stop sharing first.' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists product_combo_parts_check on public.product_combo_parts;
create trigger product_combo_parts_check
  before insert on public.product_combo_parts
  for each row execute function public.check_combo_part();


-- The combo's figure, worked out from its parts. Null only when
-- no part keeps a count. least()/min() ignore uncounted parts.
create or replace function public.combo_stock(p_combo_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select min(greatest(0, p.stock_on_hand))::integer
  from public.product_combo_parts c
  join public.products p on p.id = c.part_id
  where c.combo_id = p_combo_id;
$$;

revoke all on function public.combo_stock(uuid) from public, anon;
grant execute on function public.combo_stock(uuid) to authenticated;


-- Put a combo's stored figure back to its lowest part.
create or replace function public.refresh_combo_stock(p_combo_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products p
     set stock_on_hand = public.combo_stock(p_combo_id)
   where p.id = p_combo_id
     and exists (select 1 from public.product_combo_parts c where c.combo_id = p_combo_id)
     and p.stock_on_hand is distinct from public.combo_stock(p_combo_id);
$$;

revoke all on function public.refresh_combo_stock(uuid) from public, anon;


-- A part's figure changed: every combo it belongs to is refreshed.
-- Also runs when a combo's own figure is moved, AFTER its parts
-- have been moved (see below), which puts it back to the lowest.
create or replace function public.combo_stock_follows_parts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_combo uuid;
  v_delta integer;
begin
  if new.stock_on_hand is not distinct from old.stock_on_hand then
    return null;
  end if;

  -- This row is a combo, and somebody moved its figure directly
  -- (an approval, an undo, the phone) rather than this trigger
  -- refreshing it. Move each part by the same amount — one write
  -- per physical shelf, so two parts that share a shelf are not
  -- moved twice — then refresh the combo from its parts.
  --
  -- pg_trigger_depth() = 1 means the write came from a statement,
  -- not from one of these triggers; the refresh below and the
  -- shared-stock mirror both write at a deeper level, so they are
  -- never mistaken for a sale.
  if pg_trigger_depth() = 1
     and old.stock_on_hand is not null
     and new.stock_on_hand is not null
     and exists (select 1 from public.product_combo_parts c where c.combo_id = new.id) then
    v_delta := new.stock_on_hand - old.stock_on_hand;
    update public.products p
       set stock_on_hand = greatest(0, p.stock_on_hand + v_delta)
     where p.stock_on_hand is not null
       and p.id in (
         select distinct on (coalesce(q.stock_group_id, q.id)) q.id
         from public.product_combo_parts c
         join public.products q on q.id = c.part_id
         where c.combo_id = new.id
         order by coalesce(q.stock_group_id, q.id), q.id
       );
    perform public.refresh_combo_stock(new.id);
  end if;

  -- This row is a part: refresh every combo it is in.
  for v_combo in
    select c.combo_id from public.product_combo_parts c where c.part_id = new.id
  loop
    perform public.refresh_combo_stock(v_combo);
  end loop;

  return null;
end;
$$;

drop trigger if exists products_combo_stock on public.products;
create trigger products_combo_stock
  after update of stock_on_hand on public.products
  for each row execute function public.combo_stock_follows_parts();


-- Adding or removing a part changes what the combo can make.
create or replace function public.combo_parts_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_combo_stock(coalesce(new.combo_id, old.combo_id));
  return null;
end;
$$;

drop trigger if exists product_combo_parts_refresh on public.product_combo_parts;
create trigger product_combo_parts_refresh
  after insert or delete on public.product_combo_parts
  for each row execute function public.combo_parts_changed();


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'product_combo_parts table' as item,
       case when to_regclass('public.product_combo_parts') is not null
            then 'OK' else 'MISSING' end as status
union all
select 'product_combo_parts has forced RLS',
       case when exists (select 1 from pg_class
                          where oid = 'public.product_combo_parts'::regclass
                            and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'MISSING' end
union all
select 'combo stock trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_combo_stock')
            then 'OK' else 'MISSING' end
union all
select 'combo parts check trigger',
       case when exists (select 1 from pg_trigger where tgname = 'product_combo_parts_check')
            then 'OK' else 'MISSING' end
union all
select 'shared-stock adopt trigger (RUN-ME-18) still live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_adopt')
            then 'OK' else 'MISSING' end;
