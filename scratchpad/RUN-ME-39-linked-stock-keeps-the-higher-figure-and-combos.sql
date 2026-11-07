-- ============================================================
-- FGT Billing — linking SKUs keeps the higher stock figure, and
-- a product can be a combo of other products.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row.
--
-- Relies on RUN-ME-8 (stock floor), RUN-ME-18 (shared stock) and
-- RUN-ME-29 (current_user_is_admin), all live.
--
-- Words used below:
--   shelf  — one physical stock. A product with no stock_group_id
--            is a shelf of its own; products sharing a
--            stock_group_id are one shelf under several SKUs
--            (RUN-ME-18). A shelf holds ANY number of SKUs.
--   combo  — a product sold as a set of one of each of its parts.
--            A combo can be sold under several SKUs too: link them
--            as shared stock and they are one combo shelf.
--            A product can be a part of any number of combos.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. The combo table
-- ------------------------------------------------------------
create table if not exists public.product_combo_parts (
  combo_id   uuid not null references public.products(id) on delete cascade,
  part_id    uuid not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (combo_id, part_id),
  constraint product_combo_parts_not_itself check (combo_id <> part_id)
);

comment on table public.product_combo_parts is
  'A combo product and the products it is made of, one of each. The combo''s stock (and every SKU sharing it) is the lowest of its parts.';

create index if not exists product_combo_parts_part_idx
  on public.product_combo_parts (part_id);

-- Rule 3: every table has RLS, forced. Anyone signed in may see
-- what a combo is made of (not a cost figure: whoever may see the
-- stock may see where it comes from); only a manager or an admin
-- may change it. Nothing for anon.
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


-- ------------------------------------------------------------
-- 2. Shelves and combo shelves
-- ------------------------------------------------------------

-- Every product on the same shelf as p_product, itself included.
create or replace function public.shelf_members(p_product uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select q.id
  from public.products me
  join public.products q
    on coalesce(q.stock_group_id, q.id) = coalesce(me.stock_group_id, me.id)
  where me.id = p_product;
$$;

-- The parts of every combo on p_product's shelf. Empty means the
-- shelf is not a combo.
create or replace function public.combo_shelf_parts(p_product uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct c.part_id
  from public.product_combo_parts c
  where c.combo_id in (select public.shelf_members(p_product));
$$;

-- What a combo shelf can make: the lowest of its parts. Null when
-- no part keeps a count.
create or replace function public.combo_stock(p_product uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select min(greatest(0, p.stock_on_hand))::integer
  from public.products p
  where p.id in (select public.combo_shelf_parts(p_product));
$$;

-- Put a combo shelf's figure back to its lowest part. One row is
-- written; the shared-stock mirror copies it to the other SKUs.
create or replace function public.refresh_combo_stock(p_product uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.products p
     set stock_on_hand = public.combo_stock(p_product)
   where p.id = p_product
     and exists (select public.combo_shelf_parts(p_product))
     and p.stock_on_hand is distinct from public.combo_stock(p_product);
$$;

revoke all on function public.shelf_members(uuid) from public, anon;
revoke all on function public.combo_shelf_parts(uuid) from public, anon;
revoke all on function public.combo_stock(uuid) from public, anon;
revoke all on function public.refresh_combo_stock(uuid) from public, anon;
grant execute on function public.combo_stock(uuid) to authenticated;


-- ------------------------------------------------------------
-- 3. One level of combo
--
-- A combo is not a part of another combo, and nothing on a combo's
-- shelf is a part of it. Checked here because the phone writes
-- tables directly; the web route asks first for a readable reply.
-- ------------------------------------------------------------
create or replace function public.check_combo_part()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.part_id in (select public.shelf_members(new.combo_id)) then
    raise exception 'COMBO_SAME_SHELF: a combo cannot contain itself or a SKU it shares stock with.'
      using errcode = '23514';
  end if;
  if exists (select public.combo_shelf_parts(new.part_id)) then
    raise exception 'COMBO_IN_COMBO: a combo cannot be a part of another combo.'
      using errcode = '23514';
  end if;
  if exists (select 1 from public.product_combo_parts c
              where c.part_id in (select public.shelf_members(new.combo_id))) then
    raise exception 'COMBO_IS_PART: a product that is part of a combo cannot be a combo itself.'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists product_combo_parts_check on public.product_combo_parts;
create trigger product_combo_parts_check
  before insert on public.product_combo_parts
  for each row execute function public.check_combo_part();


-- ------------------------------------------------------------
-- 4. Linking keeps the higher figure (owner, 2026-11-07)
--
-- Until now the product being added took the figure of the
-- product it joined, so opening a NEW SKU (0) and adding the
-- ORIGINAL (200) set the original to 0. Now the shelf keeps the
-- higher of the two. A product with no count kept (null) never
-- lowers or replaces a count.
--
-- A combo shelf is the exception: its figure is worked out, not
-- counted, so a SKU joining it (or a combo joining a plain shelf)
-- takes the combo's figure. The mirror trigger then copies the
-- result to every other SKU on the shelf.
--
-- A brand-new row inserted straight into a group still takes the
-- group's figure, as before: it has no count of its own to keep.
-- ------------------------------------------------------------
create or replace function public.adopt_shared_stock()
returns trigger
language plpgsql
as $$
declare
  group_stock  integer;
  joiner_parts boolean;
  group_parts  boolean;
  joiner_is_part boolean;
  group_has_part boolean;
begin
  if new.stock_group_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.stock_group_id is not distinct from old.stock_group_id then
    return new;
  end if;
  -- link_stock() (section 6) has already worked out the figure for
  -- the whole merged shelf and writes it with the new group id.
  if coalesce(current_setting('fgt.stock_link', true), '') = 'on' then
    return new;
  end if;

  -- One level of combo, kept across links as well.
  joiner_parts := exists (select 1 from public.product_combo_parts c where c.combo_id = new.id);
  group_parts := exists (select 1 from public.product_combo_parts c
                          join public.products p on p.id = c.combo_id
                         where p.stock_group_id = new.stock_group_id and p.id <> new.id);
  joiner_is_part := exists (select 1 from public.product_combo_parts c where c.part_id = new.id);
  group_has_part := exists (select 1 from public.product_combo_parts c
                             join public.products p on p.id = c.part_id
                            where p.stock_group_id = new.stock_group_id and p.id <> new.id);
  if (joiner_parts and group_has_part) or (group_parts and joiner_is_part) then
    raise exception 'COMBO_LINK: a combo cannot share stock with a product it is made of, or with part of another combo.'
      using errcode = '23514';
  end if;
  if joiner_parts or group_parts then
    -- A combo shelf: the lowest part across every combo on it.
    select min(greatest(0, p.stock_on_hand))::integer into group_stock
    from public.products p
    where p.id in (
      select c.part_id
      from public.product_combo_parts c
      join public.products k on k.id = c.combo_id
      where k.stock_group_id = new.stock_group_id or k.id = new.id
    );
    if group_stock is not null then
      new.stock_on_hand := group_stock;
    end if;
    return new;
  end if;

  select max(p.stock_on_hand) into group_stock
  from public.products p
  where p.stock_group_id = new.stock_group_id
    and p.id <> new.id;
  if group_stock is null then
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


-- The RUN-ME-18 mirror, copying what the row holds NOW rather than
-- the figure it was written with. A combo's own trigger can put
-- the row back to its lowest part in between, and the other SKUs
-- must get that, not the number before it.
create or replace function public.mirror_shared_stock()
returns trigger
language plpgsql
as $$
declare
  current_stock integer;
begin
  if new.stock_group_id is null then
    return null;
  end if;
  if new.stock_on_hand is not distinct from old.stock_on_hand
     and new.stock_group_id is not distinct from old.stock_group_id then
    return null;
  end if;
  select p.stock_on_hand into current_stock from public.products p where p.id = new.id;
  update public.products p
  set stock_on_hand = current_stock
  where p.stock_group_id = new.stock_group_id
    and p.id <> new.id
    and p.stock_on_hand is distinct from current_stock;
  return null;
end;
$$;


-- ------------------------------------------------------------
-- 5. Combo stock follows its parts, and a sale takes the parts
--
-- Every path that moves stock — approving, undoing an approval,
-- restoring, deleting, the phone — writes one row's figure. None
-- of them need to know about combos:
--
--   • a PART moved: every combo shelf it is in is refreshed to its
--     lowest part;
--   • a SKU on a COMBO shelf moved (any of its SKUs): each part is
--     moved by the same amount — one write per part shelf, so two
--     parts sharing a shelf are not moved twice — and the combo is
--     refreshed.
--
-- pg_trigger_depth() = 1 means the write came from a statement,
-- not from one of these triggers. The refresh and the shared-stock
-- mirror write at a deeper level, so they are never taken for a
-- sale. A shelf is moved by ONE row per statement (the approve
-- function pools by shelf), so a sale is applied once.
-- ------------------------------------------------------------
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

  -- link_stock() (section 6) sets the figure of a merged shelf
  -- directly; that is not a sale, so no part moves.
  if pg_trigger_depth() = 1
     and coalesce(current_setting('fgt.stock_link', true), '') <> 'on'
     and old.stock_on_hand is not null
     and new.stock_on_hand is not null
     and exists (select public.combo_shelf_parts(new.id)) then
    v_delta := new.stock_on_hand - old.stock_on_hand;
    update public.products p
       set stock_on_hand = greatest(0, p.stock_on_hand + v_delta)
     where p.stock_on_hand is not null
       and p.id in (
         select distinct on (coalesce(q.stock_group_id, q.id)) q.id
         from public.products q
         where q.id in (select public.combo_shelf_parts(new.id))
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
-- 6. Linking merges shelves (owner, 2026-11-08)
--
-- "Multiple SKU and combo products should be able to link to the
-- same stock." Adding a product that already shares stock used to
-- take it off its shelf, after asking. Now both shelves become ONE:
-- every SKU on either side ends up sharing the one figure, and
-- nothing is asked.
--
--   link_stock(product, partner)
--     -> {"result":"linked","stock_group_id":…,"members":[{id,sku,stock_on_hand},…]}
--        {"result":"already"}   the two already share stock
--
-- The merged figure: on a combo shelf, the lowest part (it is
-- worked out, not counted); otherwise the HIGHEST counted figure
-- among every SKU joining, as on 2026-11-07. Linking moves no
-- part's stock.
--
-- Refused (COMBO_LINK): a shelf holding a combo AND one of its own
-- parts, or a combo AND part of any combo — one sale would then
-- move the same stock twice.
--
-- One transaction, the rows locked, so both apps get the same
-- answer and nothing is left half-merged. The phone and the web
-- both call it.
-- ------------------------------------------------------------
create or replace function public.link_stock(p_product uuid, p_partner uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target  uuid;
  v_all     uuid[];
  v_combo   boolean;
  v_figure  integer;
  v_members jsonb;
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can link stock.' using errcode = '42501';
  end if;
  if p_product is null or p_partner is null or p_product = p_partner then
    raise exception 'Pick two different products.' using errcode = '22023';
  end if;

  select array_agg(id) into v_all
  from (select public.shelf_members(p_product) as id
        union
        select public.shelf_members(p_partner)) s;
  if v_all is null or not (p_product = any(v_all)) or not (p_partner = any(v_all)) then
    raise exception 'Product not found.' using errcode = 'P0002';
  end if;
  if p_product in (select public.shelf_members(p_partner)) then
    return jsonb_build_object('result', 'already');
  end if;

  -- Lock every SKU of both shelves, in one fixed order.
  perform 1 from public.products p where p.id = any(v_all) order by p.id for update;

  -- One level of combo on the merged shelf.
  if exists (select 1 from public.product_combo_parts c
              where c.combo_id = any(v_all) and c.part_id = any(v_all))
     or (exists (select 1 from public.product_combo_parts c where c.combo_id = any(v_all))
         and exists (select 1 from public.product_combo_parts c where c.part_id = any(v_all))) then
    raise exception 'COMBO_LINK: a combo cannot share stock with a product it is made of, or with part of another combo.'
      using errcode = '23514';
  end if;

  v_combo := exists (select 1 from public.product_combo_parts c where c.combo_id = any(v_all));
  if v_combo then
    select min(greatest(0, p.stock_on_hand))::integer into v_figure
    from public.products p
    where p.id in (select c.part_id from public.product_combo_parts c where c.combo_id = any(v_all));
  else
    select max(p.stock_on_hand) into v_figure
    from public.products p
    where p.id = any(v_all);
  end if;

  -- The partner's shelf keeps its id; a partner on its own starts one.
  select coalesce(p.stock_group_id, gen_random_uuid()) into v_target
  from public.products p where p.id = p_partner;

  perform set_config('fgt.stock_link', 'on', true);
  update public.products p
     set stock_group_id = v_target,
         stock_on_hand  = coalesce(v_figure, p.stock_on_hand)
   where p.id = any(v_all);
  perform set_config('fgt.stock_link', 'off', true);

  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'stock_on_hand', p.stock_on_hand)
                            order by p.sku), '[]'::jsonb)
    into v_members
  from public.products p
  where p.stock_group_id = v_target;

  return jsonb_build_object('result', 'linked', 'stock_group_id', v_target, 'members', v_members);
end;
$$;

revoke all on function public.link_stock(uuid, uuid) from public, anon;
grant execute on function public.link_stock(uuid, uuid) to authenticated;


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
select 'link_stock function',
       case when exists (select 1 from pg_proc where proname = 'link_stock')
            then 'OK' else 'MISSING' end
union all
select 'combo parts check trigger',
       case when exists (select 1 from pg_trigger where tgname = 'product_combo_parts_check')
            then 'OK' else 'MISSING' end
union all
select 'shared-stock triggers (RUN-ME-18) still live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_adopt')
             and exists (select 1 from pg_trigger where tgname = 'products_stock_group_mirror')
            then 'OK' else 'MISSING' end
union all
select 'no shelf disagrees with itself',
       case when not exists (
              select 1 from public.products
              where stock_group_id is not null
              group by stock_group_id
              having count(distinct coalesce(stock_on_hand, -1)) > 1)
            then 'OK' else 'MISMATCH' end;
