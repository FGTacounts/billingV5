-- ============================================================
-- FGT Billing — SKUs sharing stock carry one cost, and a combo's
-- cost is the cost of what it is made of.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. CHANGES NO EXISTING COST: every
-- product keeps the cost it has today (owner, 2026-11-15: "leave
-- them, don't change the cost"). The rules below apply from the
-- next change on.
--
-- Relies on RUN-ME-18 (shared stock), RUN-ME-33 (a cost can't be
-- cleared), RUN-ME-39 (combos, link_stock) and RUN-ME-40 (part
-- quantities), all live.
--
-- Owner, 2026-11-15: "For the combo and shared item cost is going
-- to be determined from the main product too (only cost and not
-- price). Also if it is a combo product."
--
--   • Shared stock: every SKU on one shelf carries ONE cost.
--     Changing the cost of any of them changes all of them.
--     Linking takes the cost of the product the link is made FROM
--     (the one open in the editor — link_stock's p_partner); if it
--     has no cost yet, the product added; failing that, the lowest
--     cost on either shelf.
--   • Combo: its cost is each part's cost × how many go into one
--     set, added up — the same parts and quantities its stock is
--     worked out from (two parts sharing one stock count once, at
--     the larger quantity). It follows its parts: a part's cost,
--     a part added or taken out, or a quantity changed sets it
--     again. While any part has no cost the combo keeps the cost
--     it holds and can be typed as before.
--   • Price is never touched.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. What a combo shelf costs
--
-- One line per part shelf: the larger quantity, the part's cost
-- (the lowest cost above 0 among the SKUs listed for that shelf).
-- Null when the shelf is not a combo or any part has no cost.
-- ------------------------------------------------------------
create or replace function public.combo_cost(p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  with lines as (
    select max(c.qty) as qty,
           min(q.cost) filter (where q.cost > 0) as cost
    from public.product_combo_parts c
    join public.products q on q.id = c.part_id
    where c.combo_id in (select public.shelf_members(p_product))
    group by coalesce(q.stock_group_id, q.id)
  )
  select case when count(*) = 0 or bool_or(l.cost is null) then null
              else sum(l.qty * l.cost) end
  from lines l;
$$;

-- Put every SKU of a combo shelf at what its parts cost. Nothing
-- is written while a part has no cost.
create or replace function public.refresh_combo_cost(p_product uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost numeric;
begin
  v_cost := public.combo_cost(p_product);
  if v_cost is null then
    return;
  end if;
  update public.products p
     set cost = v_cost
   where p.id in (select public.shelf_members(p_product))
     and p.cost is distinct from v_cost;
end;
$$;

revoke all on function public.combo_cost(uuid) from public, anon, authenticated;
revoke all on function public.refresh_combo_cost(uuid) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 2. Nobody types a combo's cost
--
-- A cost written to a SKU on a combo shelf is replaced by what
-- its parts cost, so Save from an open form (web or phone) or an
-- imported sheet cannot set it to something else. Runs before
-- RUN-ME-33's check (triggers fire in name order), so that check
-- sees the cost that will be stored.
-- ------------------------------------------------------------
create or replace function public.combo_cost_is_worked_out()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost numeric;
begin
  if new.cost is not distinct from old.cost then
    return new;
  end if;
  -- link_stock() works out the merged shelf's cost itself.
  if coalesce(current_setting('fgt.stock_link', true), '') = 'on' then
    return new;
  end if;
  v_cost := public.combo_cost(new.id);
  if v_cost is not null then
    new.cost := v_cost;
  end if;
  return new;
end;
$$;

drop trigger if exists products_combo_cost_worked_out on public.products;
create trigger products_combo_cost_worked_out
  before update of cost on public.products
  for each row execute function public.combo_cost_is_worked_out();


-- ------------------------------------------------------------
-- 3. A cost change reaches the shelf and the combos
--
-- pg_trigger_depth() = 1: the change came from a statement (an
-- app, an import, link_stock), not from this trigger's own
-- writes, which run deeper and are left alone.
--
--   • every other SKU on the shelf takes the same cost (not
--     during link_stock, which writes the whole shelf itself);
--   • every combo this shelf is a part of is costed again.
-- ------------------------------------------------------------
create or replace function public.cost_follows_shelf()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_combo uuid;
begin
  if new.cost is not distinct from old.cost then
    return null;
  end if;
  if pg_trigger_depth() > 1 then
    return null;
  end if;

  if new.stock_group_id is not null
     and coalesce(current_setting('fgt.stock_link', true), '') <> 'on' then
    update public.products p
       set cost = new.cost
     where p.stock_group_id = new.stock_group_id
       and p.id <> new.id
       and p.cost is distinct from new.cost;
  end if;

  for v_combo in
    select distinct c.combo_id
    from public.product_combo_parts c
    where c.part_id in (select public.shelf_members(new.id))
  loop
    perform public.refresh_combo_cost(v_combo);
  end loop;

  return null;
end;
$$;

drop trigger if exists products_cost_follows_shelf on public.products;
create trigger products_cost_follows_shelf
  after update of cost on public.products
  for each row execute function public.cost_follows_shelf();


-- ------------------------------------------------------------
-- 4. A part added, taken out, or its quantity changed
--
-- The combo is costed again. Taking the last part out leaves the
-- product the cost it had then (combo_cost is null, nothing is
-- written).
-- ------------------------------------------------------------
create or replace function public.combo_parts_cost_changed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.refresh_combo_cost(coalesce(new.combo_id, old.combo_id));
  return null;
end;
$$;

drop trigger if exists product_combo_parts_cost on public.product_combo_parts;
create trigger product_combo_parts_cost
  after insert or delete or update of qty on public.product_combo_parts
  for each row execute function public.combo_parts_cost_changed();


-- ------------------------------------------------------------
-- 5. Linking takes the main product's cost
--
-- RUN-ME-40's link_stock with the cost added; the stock rules are
-- unchanged. The web and the phone call it as
-- link_stock(<product added>, <product open in the editor>), so
-- p_partner is the main product. The answer now also carries
-- "cost": the shelf's cost (null when nobody on it has one). Only
-- a manager or an admin can call it, and both may see cost.
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
  v_cost    numeric;
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

  perform 1 from public.products p where p.id = any(v_all) order by p.id for update;

  if exists (select 1 from public.product_combo_parts c
              where c.combo_id = any(v_all) and c.part_id = any(v_all))
     or (exists (select 1 from public.product_combo_parts c where c.combo_id = any(v_all))
         and exists (select 1 from public.product_combo_parts c where c.part_id = any(v_all))) then
    raise exception 'COMBO_LINK: a combo cannot share stock with a product it is made of, or with part of another combo.'
      using errcode = '23514';
  end if;

  v_combo := exists (select 1 from public.product_combo_parts c where c.combo_id = any(v_all));
  if v_combo then
    select min(greatest(0, p.stock_on_hand) / c.qty)::integer into v_figure
    from public.product_combo_parts c
    join public.products p on p.id = c.part_id
    where c.combo_id = any(v_all);

    -- What the merged combo shelf's parts cost (section 1's rule
    -- over every combo on either side).
    with lines as (
      select max(c.qty) as qty,
             min(q.cost) filter (where q.cost > 0) as cost
      from public.product_combo_parts c
      join public.products q on q.id = c.part_id
      where c.combo_id = any(v_all)
      group by coalesce(q.stock_group_id, q.id)
    )
    select case when count(*) = 0 or bool_or(l.cost is null) then null
                else sum(l.qty * l.cost) end
      into v_cost
    from lines l;
  else
    select max(p.stock_on_hand) into v_figure
    from public.products p
    where p.id = any(v_all);
  end if;

  -- The main product's cost; then the product added; then the
  -- lowest cost on either shelf. 0 or empty is no cost.
  if v_cost is null then
    select p.cost into v_cost from public.products p where p.id = p_partner and p.cost > 0;
  end if;
  if v_cost is null then
    select p.cost into v_cost from public.products p where p.id = p_product and p.cost > 0;
  end if;
  if v_cost is null then
    select min(p.cost) into v_cost from public.products p where p.id = any(v_all) and p.cost > 0;
  end if;

  select coalesce(p.stock_group_id, gen_random_uuid()) into v_target
  from public.products p where p.id = p_partner;

  perform set_config('fgt.stock_link', 'on', true);
  update public.products p
     set stock_group_id = v_target,
         stock_on_hand  = coalesce(v_figure, p.stock_on_hand),
         cost           = coalesce(v_cost, p.cost)
   where p.id = any(v_all);
  perform set_config('fgt.stock_link', 'off', true);

  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'sku', p.sku, 'stock_on_hand', p.stock_on_hand)
                            order by p.sku), '[]'::jsonb)
    into v_members
  from public.products p
  where p.stock_group_id = v_target;

  return jsonb_build_object('result', 'linked', 'stock_group_id', v_target, 'members', v_members,
                            'cost', v_cost);
end;
$$;

revoke all on function public.link_stock(uuid, uuid) from public, anon;
grant execute on function public.link_stock(uuid, uuid) to authenticated;


-- ------------------------------------------------------------
-- 6. What a combo costs, for the editor
--
-- The apps show a combo's cost read-only with the parts' total.
-- Cost is hidden from staff (RUN-ME-4), so only a manager or an
-- admin gets a number; anyone else gets null.
-- ------------------------------------------------------------
create or replace function public.combo_cost_for_editor(p_product uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case when public.current_role_is('manager') or public.current_user_is_admin()
              then public.combo_cost(p_product) end;
$$;

revoke all on function public.combo_cost_for_editor(uuid) from public, anon;
grant execute on function public.combo_cost_for_editor(uuid) to authenticated;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK. The last two
-- only COUNT what already disagrees; nothing was changed.
-- ------------------------------------------------------------
select 'combo cost function' as item,
       case when exists (select 1 from pg_proc where proname = 'combo_cost')
            then 'OK' else 'MISSING' end as status
union all
select 'combo cost trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_combo_cost_worked_out')
            then 'OK' else 'MISSING' end
union all
select 'shelf cost trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_cost_follows_shelf')
            then 'OK' else 'MISSING' end
union all
select 'combo parts cost trigger',
       case when exists (select 1 from pg_trigger where tgname = 'product_combo_parts_cost')
            then 'OK' else 'MISSING' end
union all
select 'product_combo_parts still has forced RLS',
       case when exists (select 1 from pg_class
                          where oid = 'public.product_combo_parts'::regclass
                            and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'MISSING' end
union all
select 'shared shelves whose SKUs carry different costs today (left as they are)',
       (select count(*)::text from (
          select stock_group_id from public.products
          where stock_group_id is not null
          group by stock_group_id
          having count(distinct cost) > 1) s)
union all
select 'combos whose cost differs from their parts today (left as they are)',
       (select count(*)::text from (
          select distinct c.combo_id from public.product_combo_parts c
          join public.products k on k.id = c.combo_id
          where public.combo_cost(k.id) is not null
            and k.cost is distinct from public.combo_cost(k.id)) s);
