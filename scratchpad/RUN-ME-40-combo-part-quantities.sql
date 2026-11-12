-- ============================================================
-- FGT Billing — a combo can hold more than one of a product.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row: every
-- part already in a combo keeps a quantity of 1, which is what
-- it meant until now.
--
-- Relies on RUN-ME-39 (combos), live since 2026-11-08.
--
-- Owner, 2026-11-12: "add a + and - on each model number … because
-- some combos might have 2pcs." A part now carries how many of it
-- go into one set:
--
--   • the combo's stock is how many whole sets the parts make —
--     A 7 (×2) and B 10 (×1) make 3;
--   • selling one set takes that many of each part — 2 of A and
--     1 of B — and a return puts them back the same way.
--
-- Two parts that share one stock (RUN-ME-18) are still moved
-- once, by the larger of their two quantities, as before.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 1. The quantity
-- ------------------------------------------------------------
alter table public.product_combo_parts
  add column if not exists qty integer not null default 1;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'product_combo_parts_qty_range') then
    alter table public.product_combo_parts
      add constraint product_combo_parts_qty_range check (qty between 1 and 999);
  end if;
end;
$$;

comment on column public.product_combo_parts.qty is
  'How many of this part go into one set of the combo. 1 unless the owner set it higher.';

comment on table public.product_combo_parts is
  'A combo product and the products it is made of, qty of each. The combo''s stock (and every SKU sharing it) is how many whole sets its parts make.';

-- Only the quantity may be changed in place; which combo and which
-- part are fixed (take the part out and add another instead). RLS
-- stays forced (rule 3); nothing for anon.
grant update (qty) on public.product_combo_parts to authenticated;

drop policy if exists "manager changes combo part quantity" on public.product_combo_parts;
create policy "manager changes combo part quantity"
  on public.product_combo_parts for update to authenticated
  using (public.current_role_is('manager') or public.current_user_is_admin())
  with check (public.current_role_is('manager') or public.current_user_is_admin());


-- ------------------------------------------------------------
-- 2. What a combo shelf can make
--
-- Each part's figure divided by how many a set takes, rounded
-- down; the lowest of those. Null when no part keeps a count.
-- A part listed by two SKUs of the same combo with different
-- quantities counts at the larger one.
-- ------------------------------------------------------------
create or replace function public.combo_stock(p_product uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select min(greatest(0, p.stock_on_hand) / c.qty)::integer
  from public.product_combo_parts c
  join public.products p on p.id = c.part_id
  where c.combo_id in (select public.shelf_members(p_product));
$$;

revoke all on function public.combo_stock(uuid) from public, anon;
grant execute on function public.combo_stock(uuid) to authenticated;


-- ------------------------------------------------------------
-- 3. A sale takes qty of each part
--
-- RUN-ME-39 section 5, with the quantity: a SKU on a combo shelf
-- moving by d moves each part's shelf by d × qty. One write per
-- part shelf, as before, so two parts sharing a stock are not
-- moved twice; that shelf moves by the larger quantity.
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

  -- link_stock() sets the figure of a merged shelf directly; that
  -- is not a sale, so no part moves.
  if pg_trigger_depth() = 1
     and coalesce(current_setting('fgt.stock_link', true), '') <> 'on'
     and old.stock_on_hand is not null
     and new.stock_on_hand is not null
     and exists (select public.combo_shelf_parts(new.id)) then
    v_delta := new.stock_on_hand - old.stock_on_hand;
    update public.products p
       set stock_on_hand = greatest(0, p.stock_on_hand + v_delta * n.qty)
      from (
        select (array_agg(q.id order by q.id))[1] as one_id,
               max(c.qty) as qty
        from public.product_combo_parts c
        join public.products q on q.id = c.part_id
        where c.combo_id in (select public.shelf_members(new.id))
        group by coalesce(q.stock_group_id, q.id)
      ) n
     where p.id = n.one_id
       and p.stock_on_hand is not null;
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


-- ------------------------------------------------------------
-- 4. Changing a quantity changes what the combo can make
-- ------------------------------------------------------------
drop trigger if exists product_combo_parts_refresh on public.product_combo_parts;
create trigger product_combo_parts_refresh
  after insert or delete or update of qty on public.product_combo_parts
  for each row execute function public.combo_parts_changed();


-- ------------------------------------------------------------
-- 5. Linking onto a combo shelf takes the combo's figure
--
-- RUN-ME-39 section 4 and section 6, with the combo's figure
-- counted in sets. Nothing else in either function changes.
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
  if coalesce(current_setting('fgt.stock_link', true), '') = 'on' then
    return new;
  end if;

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
    -- A combo shelf: how many whole sets every combo on it can make.
    select min(greatest(0, p.stock_on_hand) / c.qty)::integer into group_stock
    from public.product_combo_parts c
    join public.products k on k.id = c.combo_id
    join public.products p on p.id = c.part_id
    where k.stock_group_id = new.stock_group_id or k.id = new.id;
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
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.stock_on_hand := group_stock;
  else
    new.stock_on_hand := greatest(group_stock, new.stock_on_hand);
  end if;
  return new;
end;
$$;


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
  else
    select max(p.stock_on_hand) into v_figure
    from public.products p
    where p.id = any(v_all);
  end if;

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
select 'product_combo_parts.qty' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'product_combo_parts'
                            and column_name = 'qty')
            then 'OK' else 'MISSING' end as status
union all
select 'product_combo_parts still has forced RLS',
       case when exists (select 1 from pg_class
                          where oid = 'public.product_combo_parts'::regclass
                            and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'MISSING' end
union all
select 'quantity change refreshes the combo',
       case when exists (select 1 from pg_trigger where tgname = 'product_combo_parts_refresh')
            then 'OK' else 'MISSING' end
union all
select 'every combo shows the sets its parts make',
       case when not exists (
              select 1 from public.product_combo_parts c
              join public.products k on k.id = c.combo_id
              where k.stock_on_hand is distinct from public.combo_stock(k.id)
                and public.combo_stock(k.id) is not null)
            then 'OK' else 'MISMATCH' end;
