-- ============================================================
-- FGT Billing — stock held in other countries, per SKU, and
-- moving it between warehouses.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row.
--
-- Relies on RUN-ME-18 (shared stock), RUN-ME-29
-- (current_user_is_admin) and RUN-ME-39 (shelf_members,
-- combo_shelf_parts), all live.
--
-- Owner, 2026-11-12/13: "add countries stock … we have 100 piece
-- stock for an item in India warehouse 1 … multiple countries".
-- "Current stock is only UAE. Stock can be moved." "Only some
-- products will have stock overseas … put that option under each
-- SKU." Managers and admins only: nobody else sees or changes it.
--
--   products.stock_on_hand      — the UAE stock, exactly as today.
--                                 Nothing here changes how it is
--                                 sold, returned or counted.
--   stock_warehouses            — a warehouse abroad: a country
--                                 and a name ("India", "Warehouse 1").
--   product_warehouse_stock     — how many of a SKU are in one of
--                                 those warehouses.
--
-- SKUs that share stock (RUN-ME-18) are one physical item, so they
-- share their overseas stock too: every write puts the same figure
-- on every SKU of the shelf, and a read takes the highest figure
-- among them for each warehouse — the same "keep the higher
-- figure" rule linking uses (2026-11-07), so linking two SKUs that
-- both carried India stock does not add them together.
--
-- Combos sell from the UAE only (owner, 2026-11-13), so a combo
-- shelf holds no overseas stock and cannot be moved.
--
-- Selling from an overseas warehouse is the NEXT step and is not
-- in this file.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
create table if not exists public.stock_warehouses (
  id         uuid primary key default gen_random_uuid(),
  country    text not null,
  name       text not null,
  created_at timestamptz not null default now(),
  constraint stock_warehouses_country_len check (length(btrim(country)) between 1 and 60),
  constraint stock_warehouses_name_len check (length(btrim(name)) between 1 and 80)
);

comment on table public.stock_warehouses is
  'A warehouse outside the UAE (country + name). The UAE stock is products.stock_on_hand, not a row here.';

create unique index if not exists stock_warehouses_country_name_key
  on public.stock_warehouses (lower(btrim(country)), lower(btrim(name)));

create table if not exists public.product_warehouse_stock (
  product_id   uuid not null references public.products(id) on delete cascade,
  warehouse_id uuid not null references public.stock_warehouses(id) on delete restrict,
  qty          integer not null,
  updated_at   timestamptz not null default now(),
  primary key (product_id, warehouse_id),
  constraint product_warehouse_stock_qty_not_negative check (qty >= 0)
);

comment on table public.product_warehouse_stock is
  'How many of a SKU are in an overseas warehouse. Every SKU sharing stock carries the same figure; written only through set_warehouse_stock / move_stock.';

create index if not exists product_warehouse_stock_warehouse_idx
  on public.product_warehouse_stock (warehouse_id);


-- Rule 3: RLS on, forced. Managers and admins may read; nobody
-- writes the tables directly — the functions below do, after
-- checking the role, so the shared-stock copies cannot drift.
-- Nothing at all for anon.
alter table public.stock_warehouses enable row level security;
alter table public.stock_warehouses force row level security;
alter table public.product_warehouse_stock enable row level security;
alter table public.product_warehouse_stock force row level security;

revoke all on public.stock_warehouses from anon, authenticated;
revoke all on public.product_warehouse_stock from anon, authenticated;
grant select on public.stock_warehouses to authenticated;
grant select on public.product_warehouse_stock to authenticated;

drop policy if exists "manager reads warehouses" on public.stock_warehouses;
create policy "manager reads warehouses"
  on public.stock_warehouses for select to authenticated
  using (public.current_role_is('manager') or public.current_user_is_admin());

drop policy if exists "manager reads warehouse stock" on public.product_warehouse_stock;
create policy "manager reads warehouse stock"
  on public.product_warehouse_stock for select to authenticated
  using (public.current_role_is('manager') or public.current_user_is_admin());


-- ------------------------------------------------------------
-- 2. Helpers
-- ------------------------------------------------------------
create or replace function public.warehouse_stock_require_manager()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'WAREHOUSE_MANAGER_ONLY: only a manager can see or change stock in other countries.'
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.warehouse_stock_refuse_combo(p_product uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if exists (select public.combo_shelf_parts(p_product)) then
    raise exception 'WAREHOUSE_COMBO: a combo sells from the UAE only and holds no stock in other countries.'
      using errcode = '23514';
  end if;
end;
$$;

-- The shelf's figure in one warehouse: the highest among its SKUs.
-- 0 when none of them has a row.
create or replace function public.warehouse_shelf_qty(p_product uuid, p_warehouse uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(max(s.qty), 0)::integer
  from public.product_warehouse_stock s
  where s.warehouse_id = p_warehouse
    and s.product_id in (select public.shelf_members(p_product));
$$;

-- Put one figure on every SKU of the shelf for one warehouse.
create or replace function public.warehouse_shelf_write(p_product uuid, p_warehouse uuid, p_qty integer)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.product_warehouse_stock (product_id, warehouse_id, qty, updated_at)
  select m, p_warehouse, p_qty, now()
  from public.shelf_members(p_product) as m
  on conflict (product_id, warehouse_id)
  do update set qty = excluded.qty, updated_at = excluded.updated_at;
$$;

revoke all on function public.warehouse_stock_require_manager() from public, anon, authenticated;
revoke all on function public.warehouse_stock_refuse_combo(uuid) from public, anon, authenticated;
revoke all on function public.warehouse_shelf_qty(uuid, uuid) from public, anon, authenticated;
revoke all on function public.warehouse_shelf_write(uuid, uuid, integer) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 3. What the apps call
-- ------------------------------------------------------------

-- Every overseas warehouse, for the picker.
create or replace function public.list_stock_warehouses()
returns table (id uuid, country text, name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.warehouse_stock_require_manager();
  return query
    select w.id, w.country, w.name
    from public.stock_warehouses w
    order by lower(w.country), lower(w.name);
end;
$$;

-- Adds a warehouse, or returns the one already called that
-- (ignoring case and spaces at the ends).
create or replace function public.add_stock_warehouse(p_country text, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.warehouse_stock_require_manager();
  select w.id into v_id
  from public.stock_warehouses w
  where lower(btrim(w.country)) = lower(btrim(p_country))
    and lower(btrim(w.name)) = lower(btrim(p_name));
  if v_id is not null then
    return v_id;
  end if;
  insert into public.stock_warehouses (country, name)
  values (btrim(p_country), btrim(p_name))
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    -- Someone added the same one a moment ago.
    select w.id into v_id
    from public.stock_warehouses w
    where lower(btrim(w.country)) = lower(btrim(p_country))
      and lower(btrim(w.name)) = lower(btrim(p_name));
  end if;
  return v_id;
end;
$$;

-- The overseas stock of a SKU's shelf, one row per warehouse that
-- any SKU of the shelf has a row for.
create or replace function public.warehouse_stock_for(p_product uuid)
returns table (warehouse_id uuid, country text, name text, qty integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.warehouse_stock_require_manager();
  return query
    select w.id, w.country, w.name, max(s.qty)::integer
    from public.product_warehouse_stock s
    join public.stock_warehouses w on w.id = s.warehouse_id
    where s.product_id in (select public.shelf_members(p_product))
    group by w.id, w.country, w.name
    order by lower(w.country), lower(w.name);
end;
$$;

-- Every product's overseas total, for the Products list. Products
-- with none are left out.
create or replace function public.overseas_stock_totals()
returns table (product_id uuid, total integer)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform public.warehouse_stock_require_manager();
  return query
    with per_shelf as (
      select coalesce(q.stock_group_id, q.id) as shelf, s.warehouse_id, max(s.qty) as qty
      from public.product_warehouse_stock s
      join public.products q on q.id = s.product_id
      group by 1, 2
    ), shelf_total as (
      select shelf, sum(qty)::integer as total from per_shelf group by shelf
    )
    select p.id, t.total
    from public.products p
    join shelf_total t on t.shelf = coalesce(p.stock_group_id, p.id)
    where t.total > 0;
end;
$$;

-- Sets a SKU's figure in one warehouse (a count, typed by a
-- manager). Every SKU sharing its stock gets the same figure.
create or replace function public.set_warehouse_stock(p_product uuid, p_warehouse uuid, p_qty integer)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.warehouse_stock_require_manager();
  perform public.warehouse_stock_refuse_combo(p_product);
  if p_qty is null or p_qty < 0 then
    raise exception 'WAREHOUSE_QTY: the quantity must be 0 or more.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.stock_warehouses w where w.id = p_warehouse) then
    raise exception 'WAREHOUSE_UNKNOWN: that warehouse does not exist.' using errcode = '23503';
  end if;
  perform public.warehouse_shelf_write(p_product, p_warehouse, p_qty);
  return p_qty;
end;
$$;

-- Takes a warehouse off a SKU (and every SKU sharing its stock).
-- The warehouse itself stays, for other SKUs.
create or replace function public.remove_warehouse_stock(p_product uuid, p_warehouse uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.warehouse_stock_require_manager();
  delete from public.product_warehouse_stock s
  where s.warehouse_id = p_warehouse
    and s.product_id in (select public.shelf_members(p_product));
end;
$$;

-- Moves stock between two places in one transaction. A null
-- warehouse is the UAE (products.stock_on_hand). Refused when the
-- place it comes from has fewer than asked, and when the UAE side
-- keeps no count (an uncounted shelf is not an empty one).
--
-- Returns {"uae": <UAE figure after>, "from": <figure after>,
-- "to": <figure after>}.
create or replace function public.move_stock(p_product uuid, p_from uuid, p_to uuid, p_qty integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uae integer;
  v_have integer;
  v_from_after integer;
  v_to_after integer;
begin
  perform public.warehouse_stock_require_manager();
  perform public.warehouse_stock_refuse_combo(p_product);
  if p_qty is null or p_qty <= 0 then
    raise exception 'WAREHOUSE_QTY: the quantity to move must be more than 0.' using errcode = '22023';
  end if;
  if p_from is not distinct from p_to then
    raise exception 'STOCK_MOVE_SAME: choose two different places.' using errcode = '22023';
  end if;
  if (p_from is not null and not exists (select 1 from public.stock_warehouses w where w.id = p_from))
     or (p_to is not null and not exists (select 1 from public.stock_warehouses w where w.id = p_to)) then
    raise exception 'WAREHOUSE_UNKNOWN: that warehouse does not exist.' using errcode = '23503';
  end if;

  -- Lock everything this touches, so two moves (or a move and a
  -- sale) of the same SKU queue up instead of both reading the
  -- same starting figure.
  perform 1 from public.products p
   where p.id in (select public.shelf_members(p_product))
   order by p.id
   for update;
  perform 1 from public.product_warehouse_stock s
   where s.product_id in (select public.shelf_members(p_product))
     and s.warehouse_id in (p_from, p_to)
   order by s.product_id, s.warehouse_id
   for update;

  select p.stock_on_hand into v_uae from public.products p where p.id = p_product;
  if (p_from is null or p_to is null) and v_uae is null then
    raise exception 'STOCK_MOVE_UAE_UNCOUNTED: this SKU keeps no UAE stock count. Set its UAE stock first.'
      using errcode = '22023';
  end if;

  -- Take it off where it comes from.
  if p_from is null then
    v_have := greatest(0, v_uae);
  else
    v_have := public.warehouse_shelf_qty(p_product, p_from);
  end if;
  if v_have < p_qty then
    raise exception 'STOCK_MOVE_SHORT: only % there to move.', v_have using errcode = '22023';
  end if;
  v_from_after := v_have - p_qty;
  if p_from is null then
    -- One row; the shared-stock mirror copies it to the other SKUs.
    update public.products p set stock_on_hand = v_from_after where p.id = p_product;
  else
    perform public.warehouse_shelf_write(p_product, p_from, v_from_after);
  end if;

  -- Put it where it goes.
  if p_to is null then
    update public.products p set stock_on_hand = greatest(0, p.stock_on_hand) + p_qty where p.id = p_product
    returning p.stock_on_hand into v_to_after;
  else
    v_to_after := public.warehouse_shelf_qty(p_product, p_to) + p_qty;
    perform public.warehouse_shelf_write(p_product, p_to, v_to_after);
  end if;

  select p.stock_on_hand into v_uae from public.products p where p.id = p_product;
  return jsonb_build_object('uae', v_uae, 'from', v_from_after, 'to', v_to_after);
end;
$$;

revoke all on function public.list_stock_warehouses() from public, anon;
revoke all on function public.add_stock_warehouse(text, text) from public, anon;
revoke all on function public.warehouse_stock_for(uuid) from public, anon;
revoke all on function public.overseas_stock_totals() from public, anon;
revoke all on function public.set_warehouse_stock(uuid, uuid, integer) from public, anon;
revoke all on function public.remove_warehouse_stock(uuid, uuid) from public, anon;
revoke all on function public.move_stock(uuid, uuid, uuid, integer) from public, anon;
grant execute on function public.list_stock_warehouses() to authenticated;
grant execute on function public.add_stock_warehouse(text, text) to authenticated;
grant execute on function public.warehouse_stock_for(uuid) to authenticated;
grant execute on function public.overseas_stock_totals() to authenticated;
grant execute on function public.set_warehouse_stock(uuid, uuid, integer) to authenticated;
grant execute on function public.remove_warehouse_stock(uuid, uuid) to authenticated;
grant execute on function public.move_stock(uuid, uuid, uuid, integer) to authenticated;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'stock_warehouses has forced RLS' as item,
       case when exists (select 1 from pg_class
                         where oid = 'public.stock_warehouses'::regclass
                           and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'MISSING' end as status
union all
select 'product_warehouse_stock has forced RLS',
       case when exists (select 1 from pg_class
                         where oid = 'public.product_warehouse_stock'::regclass
                           and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'MISSING' end
union all
select 'anon cannot read warehouses',
       case when not has_table_privilege('anon', 'public.stock_warehouses', 'select')
             and not has_table_privilege('anon', 'public.product_warehouse_stock', 'select')
            then 'OK' else 'FAIL' end
union all
select 'nobody writes the tables directly',
       case when not has_table_privilege('authenticated', 'public.product_warehouse_stock', 'insert')
             and not has_table_privilege('authenticated', 'public.product_warehouse_stock', 'update')
             and not has_table_privilege('authenticated', 'public.stock_warehouses', 'insert')
            then 'OK' else 'FAIL' end
union all
select 'move_stock exists',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'move_stock')
            then 'OK' else 'MISSING' end
union all
select 'shelf_members (RUN-ME-39) is live',
       case when exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname = 'shelf_members')
            then 'OK' else 'MISSING — run RUN-ME-39 first' end;
