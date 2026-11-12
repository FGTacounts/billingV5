-- ============================================================
-- FGT Billing — orders from another country.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row: every
-- order made so far stays a UAE order.
--
-- Run RUN-ME-41 (stock in other countries) FIRST. Relies on
-- RUN-ME-35 (approve/unapprove), RUN-ME-38 (manager_edit_order
-- with the order's own VAT rate) and RUN-ME-39 (shelves, combos).
-- It stops at the first line below if 41 or 38 is missing.
--
-- Owner, 2026-11-13: "Only the manager can make orders from other
-- countries, by default it is UAE. Manager has option to change
-- country when importing or making an order." "There is no
-- warehouse steps for overseas orders. Only stock and orders which
-- only the manager and admin manages." Combos: UAE only for now.
--
--   orders.stock_warehouse_id  — null: a UAE order, exactly as
--                                today. Set: the order's stock
--                                comes from that warehouse abroad
--                                (RUN-ME-41's product_warehouse_stock)
--                                and the UAE stock is not touched.
--
-- What changes:
--   • approve_order_take_stock, unapprove_order_give_stock and
--     manager_edit_order take/give an overseas order's stock from
--     its warehouse, by the same rules as the UAE (one figure per
--     shared shelf, short lines reported, never below zero). A UAE
--     order runs the code it ran before, unchanged.
--   • order_warehouse_stock_move — for the web's delete, restore
--     and edit-grant routes, which move UAE stock in the app.
--   • Only a manager or admin may set the country, and it cannot
--     change once the order's stock has been taken.
--   • Salesmen and warehouse staff do not see overseas orders at
--     all (a RESTRICTIVE policy, added on top of the ones there).
--
-- Goods returns (GRVs) still put stock back in the UAE: a return
-- belongs to a customer, not to an order.
-- ------------------------------------------------------------

do $$
begin
  if to_regclass('public.product_warehouse_stock') is null then
    raise exception 'Run RUN-ME-41-country-stock.sql first.';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'orders'
                   and column_name = 'vat_rate_override') then
    raise exception 'Run RUN-ME-38-order-vat-and-vat-numbers.sql first.';
  end if;
end;
$$;


-- ------------------------------------------------------------
-- 1. Which country an order's stock comes from
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists stock_warehouse_id uuid
  references public.stock_warehouses(id) on delete restrict;

comment on column public.orders.stock_warehouse_id is
  'Null: a UAE order (stock from products.stock_on_hand). Set: stock comes from this overseas warehouse. Managers only; fixed once the stock is taken.';

create index if not exists orders_stock_warehouse_idx
  on public.orders (stock_warehouse_id) where stock_warehouse_id is not null;

create or replace function public.guard_order_stock_warehouse()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.stock_warehouse_id is not distinct from old.stock_warehouse_id then
    return new;
  end if;
  if tg_op = 'INSERT' and new.stock_warehouse_id is null then
    return new;
  end if;
  -- A signed-in person must be a manager or an admin. The server's
  -- own key (no user: the web's create and import routes, which
  -- check the role themselves) passes.
  if (select auth.uid()) is not null
     and not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'ORDER_COUNTRY_MANAGER_ONLY: only a manager can make an order from another country.'
      using errcode = '42501';
  end if;
  if tg_op = 'UPDATE'
     and old.status::text in ('approved', 'edit_requested', 'delivering', 'delivered', 'cancelled') then
    raise exception 'ORDER_COUNTRY_FIXED: the stock for this order has already been taken; its country cannot change.'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_stock_warehouse on public.orders;
create trigger orders_guard_stock_warehouse
  before insert or update of stock_warehouse_id on public.orders
  for each row execute function public.guard_order_stock_warehouse();


-- ------------------------------------------------------------
-- 2. Overseas orders are for managers and admins only
--
-- RESTRICTIVE: it is ANDed with every policy already on orders, so
-- it changes nothing for a UAE order and nothing for a manager.
-- Lines, payments and reports are all read by order id from orders,
-- so a hidden order hides with them.
-- ------------------------------------------------------------
drop policy if exists "overseas orders are managers only" on public.orders;
create policy "overseas orders are managers only"
  on public.orders
  as restrictive
  for all
  to authenticated
  using (
    stock_warehouse_id is null
    or (select public.current_role_is('manager'))
    or (select public.current_user_is_admin())
  )
  with check (
    stock_warehouse_id is null
    or (select public.current_role_is('manager'))
    or (select public.current_user_is_admin())
  );


-- ------------------------------------------------------------
-- 3. Approving and taking an approval back
-- ------------------------------------------------------------
create or replace function public.approve_order_take_stock(
  p_order_id    uuid,
  p_allow_short boolean,
  p_subtotal    numeric,
  p_vat_amount  numeric,
  p_total       numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_short  jsonb;
  v_wh     uuid;     -- RUN-ME-42: the overseas warehouse, null = UAE
  v_move   record;
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can approve an order.' using errcode = '42501';
  end if;
  if p_subtotal is null or p_vat_amount is null or p_total is null
     or p_subtotal < 0 or p_vat_amount < 0 or p_total < 0 then
    raise exception 'The billed figures are missing.' using errcode = '22023';
  end if;

  -- Locked: a second approval of this order waits here, then finds
  -- it approved.
  select o.status::text, o.stock_warehouse_id into v_status, v_wh
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_status is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  -- The stages whose stock approval has already taken
  -- (manager_edit_order, RUN-ME-28, uses the same list).
  if v_status in ('approved', 'edit_requested', 'delivering', 'delivered') then
    return jsonb_build_object('result', 'already_approved');
  end if;
  if v_status not in ('accepted', 'waiting', 'picking', 'packed') then
    raise exception 'This order is % and cannot be approved.', v_status
      using errcode = 'P0001';
  end if;

  -- Lock the shelves this order draws on, in one fixed order, so the
  -- check below reads figures nobody else is changing.
  perform 1
  from public.products p
  where coalesce(p.stock_group_id, p.id) in (
    select coalesce(q.stock_group_id, q.id)
    from public.order_items i
    join public.products q on q.id = i.product_id
    where i.order_id = p_order_id
  )
  order by p.id
  for update of p;

  -- RUN-ME-42: an overseas order takes its stock from its warehouse,
  -- by the same rules — one figure per shelf, short lines reported
  -- unless approving anyway, never below zero. Combos sell from the
  -- UAE only.
  if v_wh is not null then
    if exists (select 1 from public.order_items i
                where i.order_id = p_order_id and i.product_id is not null
                  and exists (select 1 from public.combo_shelf_parts(i.product_id))) then
      raise exception 'WAREHOUSE_COMBO: a combo sells from the UAE only and cannot be on an order from another country.'
        using errcode = '23514';
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('sku', n.sku, 'need', n.need, 'have', n.have)
                              order by n.sku), '[]'::jsonb)
      into v_short
    from (
      select min(q.sku) as sku,
             sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need,
             public.warehouse_shelf_qty(min(q.id::text)::uuid, v_wh) as have
      from public.order_items i
      join public.products q on q.id = i.product_id
      where i.order_id = p_order_id
      group by coalesce(q.stock_group_id, q.id)
    ) n
    where n.need > n.have;

    if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_short, false) then
      return jsonb_build_object('result', 'short', 'short', v_short);
    end if;

    for v_move in
      select min(q.id::text)::uuid as product_id,
             sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need
      from public.order_items i
      join public.products q on q.id = i.product_id
      where i.order_id = p_order_id
      group by coalesce(q.stock_group_id, q.id)
    loop
      continue when v_move.need <= 0;
      perform public.warehouse_shelf_write(
        v_move.product_id, v_wh,
        greatest(0, public.warehouse_shelf_qty(v_move.product_id, v_wh) - v_move.need));
    end loop;

    update public.orders
       set status     = 'approved',
           subtotal   = p_subtotal,
           vat_amount = p_vat_amount,
           total      = p_total
     where id = p_order_id;

    return jsonb_build_object('result', 'approved');
  end if;

  -- From here: a UAE order, exactly as before (RUN-ME-35).

  -- What the order takes from each counted shelf, against what is
  -- on it. Every product on a shared shelf holds the same figure.
  select coalesce(jsonb_agg(jsonb_build_object('sku', n.sku, 'need', n.need, 'have', n.have)
                            order by n.sku), '[]'::jsonb)
    into v_short
  from (
    select min(p.sku) as sku,
           sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need,
           greatest(0, max(p.stock_on_hand)) as have
    from public.order_items i
    join public.products p on p.id = i.product_id
    where i.order_id = p_order_id
    group by coalesce(p.stock_group_id, p.id)
    having max(p.stock_on_hand) is not null
  ) n
  where n.need > n.have;

  if jsonb_array_length(v_short) > 0 and not coalesce(p_allow_short, false) then
    return jsonb_build_object('result', 'short', 'short', v_short);
  end if;

  -- One write per shelf; the shared-stock trigger copies it to the
  -- rest of the group, and the floor keeps it at zero or above.
  update public.products p
     set stock_on_hand = greatest(0, p.stock_on_hand - n.need)
    from (
      select min(q.id::text)::uuid as product_id,
             sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need
      from public.order_items i
      join public.products q on q.id = i.product_id
      where i.order_id = p_order_id
      group by coalesce(q.stock_group_id, q.id)
    ) n
   where p.id = n.product_id
     and n.need > 0
     and p.stock_on_hand is not null;

  update public.orders
     set status     = 'approved',
         subtotal   = p_subtotal,
         vat_amount = p_vat_amount,
         total      = p_total
   where id = p_order_id;

  return jsonb_build_object('result', 'approved');
end;
$$;

revoke all on function public.approve_order_take_stock(uuid, boolean, numeric, numeric, numeric) from public, anon;
grant execute on function public.approve_order_take_stock(uuid, boolean, numeric, numeric, numeric) to authenticated;


create or replace function public.unapprove_order_give_stock(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status   text;
  v_restored integer;
  v_wh       uuid;     -- RUN-ME-42: the overseas warehouse, null = UAE
  v_move     record;
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can take an approval back.' using errcode = '42501';
  end if;

  select o.status::text, o.stock_warehouse_id into v_status, v_wh
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_status is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status <> 'approved' then
    return jsonb_build_object('result', 'not_approved', 'status', v_status);
  end if;

  -- RUN-ME-42: an overseas order's stock goes back to its warehouse.
  if v_wh is not null then
    perform 1
    from public.products p
    where coalesce(p.stock_group_id, p.id) in (
      select coalesce(q.stock_group_id, q.id)
      from public.order_items i
      join public.products q on q.id = i.product_id
      where i.order_id = p_order_id
    )
    order by p.id
    for update of p;
    v_restored := 0;
    for v_move in
      select min(q.id::text)::uuid as product_id,
             sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need
      from public.order_items i
      join public.products q on q.id = i.product_id
      where i.order_id = p_order_id
      group by coalesce(q.stock_group_id, q.id)
    loop
      continue when v_move.need <= 0;
      perform public.warehouse_shelf_write(
        v_move.product_id, v_wh,
        public.warehouse_shelf_qty(v_move.product_id, v_wh) + v_move.need);
      v_restored := v_restored + v_move.need;
    end loop;

    update public.orders
       set status = 'packed', subtotal = 0, vat_amount = 0, total = 0
     where id = p_order_id;

    return jsonb_build_object('result', 'unapproved', 'restored', v_restored);
  end if;

  -- What the order holds now goes back — a manager's edits after
  -- approval have already moved the shelf by their difference — and
  -- only onto shelves that keep a count.
  with n as (
    select min(q.id::text)::uuid as product_id,
           sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as qty
    from public.order_items i
    join public.products q on q.id = i.product_id
    where i.order_id = p_order_id
    group by coalesce(q.stock_group_id, q.id)
  ), given as (
    update public.products p
       set stock_on_hand = p.stock_on_hand + n.qty
      from n
     where p.id = n.product_id
       and n.qty > 0
       and p.stock_on_hand is not null
    returning n.qty
  )
  select coalesce(sum(qty), 0)::integer into v_restored from given;

  -- Back to packed with the billed figures cleared (NOT NULL
  -- columns, so 0), recomputed by the next approval. The invoice
  -- number stays, so approving again does not use a second one.
  update public.orders
     set status = 'packed', subtotal = 0, vat_amount = 0, total = 0
   where id = p_order_id;

  return jsonb_build_object('result', 'unapproved', 'restored', v_restored);
end;
$$;

revoke all on function public.unapprove_order_give_stock(uuid) from public, anon;
grant execute on function public.unapprove_order_give_stock(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. A manager's edit (RUN-ME-38's function, with the overseas branch)
-- ------------------------------------------------------------
create or replace function public.manager_edit_order(
  p_order_id uuid,
  p_changes  jsonb,
  p_discount numeric default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user        uuid := public.current_app_user_id();
  v_status      text;
  v_customer    uuid;
  v_deducted    boolean;
  v_past_pick   boolean;
  c             jsonb;
  v_line        public.order_items%rowtype;
  v_product     record;
  v_qty         integer;
  v_short       record;
  v_lines_fils  bigint;
  v_disc_fils   bigint;
  v_sub_fils    bigint;
  v_vat_fils    bigint;
  v_rate        numeric;
  v_country     text;
  v_before      jsonb;
  v_wh          uuid;     -- RUN-ME-42: the overseas warehouse, null = UAE
  v_move        record;
  v_have        integer;
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can change this order.' using errcode = '42501';
  end if;

  -- Locked, so two edits to one order cannot both move the same stock.
  select o.status::text, o.customer_id, o.stock_warehouse_id into v_status, v_customer, v_wh
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_status is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status = 'cancelled' then
    raise exception 'This order is in the trash. Restore it before changing it.' using errcode = 'P0001';
  end if;

  -- Statuses whose stock approval has already taken off the shelf.
  v_deducted  := v_status in ('approved', 'edit_requested', 'delivering', 'delivered');
  v_past_pick := v_status in ('packed', 'approved', 'edit_requested', 'delivering', 'delivered');

  -- What this order has taken of each product before the edit.
  -- Held in a variable, not a temporary table: this function runs
  -- with raised rights, and a temporary table's name can be claimed
  -- by the caller before it is called.
  select coalesce(jsonb_object_agg(t.product_id, t.qty), '{}'::jsonb) into v_before
  from (
    select i.product_id, sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as qty
    from public.order_items i
    where i.order_id = p_order_id and i.product_id is not null
    group by i.product_id
  ) t;

  for c in select * from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb))
  loop
    if c->>'op' = 'remove' then
      delete from public.order_items
       where id = (c->>'id')::uuid and order_id = p_order_id;

    elsif c->>'op' = 'pick' then
      if jsonb_typeof(c->'qty') = 'number' and (c->>'qty')::integer < 0 then
        raise exception 'A quantity cannot be negative.' using errcode = '22023';
      end if;
      update public.order_items
         set picked_qty   = case when jsonb_typeof(c->'qty') = 'number' then (c->>'qty')::integer end,
             picked_by_id = case when jsonb_typeof(c->'qty') = 'number' then v_user end,
             picked_at    = case when jsonb_typeof(c->'qty') = 'number' then now() end
       where id = (c->>'id')::uuid and order_id = p_order_id;
      if not found then
        raise exception 'That line is no longer on this order.' using errcode = 'P0002';
      end if;

    elsif c->>'op' = 'arrange' then
      update public.orders
         set line_order = array(select (x #>> '{}')::uuid from jsonb_array_elements(c->'ids') x)
       where id = p_order_id;

    elsif c->>'op' = 'set' and c ? 'id' and c->>'id' is not null then
      select * into v_line from public.order_items
       where id = (c->>'id')::uuid and order_id = p_order_id;
      if not found then
        raise exception 'That line is no longer on this order.' using errcode = 'P0002';
      end if;
      if c ? 'qty' and (c->>'qty')::integer < 0 then
        raise exception 'A quantity cannot be negative.' using errcode = '22023';
      end if;
      if c ? 'unit_price' and (c->>'unit_price')::numeric < 0 then
        raise exception 'A price cannot be negative.' using errcode = '22023';
      end if;
      if c ? 'price_before_discount' and (c->>'price_before_discount')::numeric < 0 then
        raise exception 'A price cannot be negative.' using errcode = '22023';
      end if;
      -- A change to what the line charges that does not say what the
      -- price before discount is (a percentage off every line, a round
      -- subtotal, a margin) keeps the price the line had before its
      -- discount, and the difference shows as discount. A line written
      -- before this column has none stored: it is the list price when
      -- the line charged less, else what it charged — what the order
      -- screen and the invoice showed for it until now.
      update public.order_items
         set picked_qty  = case when c ? 'qty' and v_line.picked_qty is not null
                                then (c->>'qty')::integer else picked_qty end,
             ordered_qty = case when c ? 'qty' and v_line.picked_qty is null
                                then (c->>'qty')::integer else ordered_qty end,
             unit_price  = case when c ? 'unit_price'
                                then (c->>'unit_price')::numeric else unit_price end,
             price_before_discount = case
               when c ? 'price_before_discount'
                 then (c->>'price_before_discount')::numeric
               when c ? 'unit_price'
                 then coalesce(v_line.price_before_discount,
                               greatest(v_line.unit_price,
                                        coalesce((select p.price from public.products p
                                                   where p.id = v_line.product_id), 0)))
               else price_before_discount end
       where id = v_line.id;

    elsif c->>'op' = 'set' then
      select p.id, p.sku, p.description, p.price, p.cost into v_product
      from public.products p
      where p.id = (c->>'product_id')::uuid;
      if not found then
        raise exception 'That product no longer exists.' using errcode = 'P0002';
      end if;
      -- RUN-ME-42: combos sell from the UAE only.
      if v_wh is not null then
        perform public.warehouse_stock_refuse_combo(v_product.id);
      end if;
      v_qty := coalesce((c->>'qty')::integer, 1);
      if v_qty <= 0 then
        raise exception 'A new line needs a quantity of at least 1.' using errcode = '22023';
      end if;
      if c ? 'price_before_discount' and (c->>'price_before_discount')::numeric < 0 then
        raise exception 'A price cannot be negative.' using errcode = '22023';
      end if;
      insert into public.order_items
        (order_id, product_id, sku, description, ordered_qty, picked_qty, unit_price, unit_cost,
         price_before_discount)
      values
        (p_order_id, v_product.id, v_product.sku, coalesce(v_product.description, v_product.sku),
         v_qty, case when v_past_pick then v_qty end,
         coalesce((c->>'unit_price')::numeric, v_product.price, 0), v_product.cost,
         (c->>'price_before_discount')::numeric);

    else
      raise exception 'Unknown change: %', c using errcode = '22023';
    end if;
  end loop;

  -- The shelf moves by the difference, but only once approval has
  -- taken the order's stock. Products sharing a shelf (RUN-ME-18)
  -- are one pool: checked together, written once, and the shared-
  -- stock trigger copies the figure to the rest of the group.
  if v_deducted and v_wh is not null then
    -- RUN-ME-42: an overseas order moves its warehouse's stock by the
    -- difference instead, shelf by shelf, refusing a raise the
    -- warehouse cannot cover.
    perform 1
    from public.products p
    where coalesce(p.stock_group_id, p.id) in (
      select coalesce(q.stock_group_id, q.id)
      from public.products q
      where q.id in (
        select i.product_id from public.order_items i where i.order_id = p_order_id
        union
        select b.key::uuid from jsonb_each_text(v_before) b
      )
    )
    order by p.id
    for update of p;

    for v_move in
      with d as (
        select a.product_id, sum(a.qty)::integer as delta
        from (
          select i.product_id, coalesce(i.picked_qty, i.ordered_qty, 0) as qty
            from public.order_items i
           where i.order_id = p_order_id and i.product_id is not null
          union all
          select b.key::uuid, -(b.value::integer) from jsonb_each_text(v_before) b
        ) a
        group by a.product_id
      )
      select min(p.id::text)::uuid as product_id, min(p.sku) as sku, sum(d.delta)::integer as need
      from d join public.products p on p.id = d.product_id
      where d.delta <> 0
      group by coalesce(p.stock_group_id, p.id)
    loop
      continue when v_move.need = 0;
      v_have := public.warehouse_shelf_qty(v_move.product_id, v_wh);
      if v_move.need > 0 and v_have < v_move.need then
        raise exception 'Only % of % left in that warehouse; this change needs % more.',
          v_have, v_move.sku, v_move.need
          using errcode = 'P0001';
      end if;
      perform public.warehouse_shelf_write(v_move.product_id, v_wh, greatest(0, v_have - v_move.need));
    end loop;

  elsif v_deducted then
    -- A raise the shelf cannot cover is refused, naming the product.
    with d as (
      select a.product_id, sum(a.qty)::integer as delta
      from (
        select i.product_id, coalesce(i.picked_qty, i.ordered_qty, 0) as qty
          from public.order_items i
         where i.order_id = p_order_id and i.product_id is not null
        union all
        select b.key::uuid, -(b.value::integer) from jsonb_each_text(v_before) b
      ) a
      group by a.product_id
    ), m as (
      select coalesce(p.stock_group_id, p.id) as pool,
             min(p.id::text)::uuid as product_id,
             sum(d.delta) as need
      from d join public.products p on p.id = d.product_id
      where d.delta <> 0
      group by coalesce(p.stock_group_id, p.id)
    )
    select p.sku, p.stock_on_hand, m.need into v_short
    from m join public.products p on p.id = m.product_id
    where m.need > 0 and p.stock_on_hand is not null and p.stock_on_hand < m.need
    limit 1;
    if found then
      raise exception 'Only % of % left on the shelf; this change needs % more.',
        v_short.stock_on_hand, v_short.sku, v_short.need
        using errcode = 'P0001';
    end if;

    with d as (
      select a.product_id, sum(a.qty)::integer as delta
      from (
        select i.product_id, coalesce(i.picked_qty, i.ordered_qty, 0) as qty
          from public.order_items i
         where i.order_id = p_order_id and i.product_id is not null
        union all
        select b.key::uuid, -(b.value::integer) from jsonb_each_text(v_before) b
      ) a
      group by a.product_id
    ), m as (
      select min(p.id::text)::uuid as product_id, sum(d.delta) as need
      from d join public.products p on p.id = d.product_id
      where d.delta <> 0
      group by coalesce(p.stock_group_id, p.id)
    )
    update public.products p
       set stock_on_hand = p.stock_on_hand - m.need
      from m
     where p.id = m.product_id
       and m.need <> 0
       and p.stock_on_hand is not null;
  end if;

  -- The totals, counted in fils and rounded once each, as
  -- lib/money.ts and Money.swift do: every line rounded, the lines
  -- added, the discount taken off, VAT rounded once on what is left.
  select coalesce(sum(round(i.unit_price * 100 * coalesce(i.picked_qty, i.ordered_qty, 0))), 0)::bigint
    into v_lines_fils
  from public.order_items i
  where i.order_id = p_order_id;

  if p_discount is not null then
    if p_discount < 0 then
      raise exception 'A discount cannot be negative.' using errcode = '22023';
    end if;
    v_disc_fils := round(p_discount * 100)::bigint;
  else
    select round(o.discount_amount * 100)::bigint into v_disc_fils
    from public.orders o where o.id = p_order_id;
  end if;
  if v_disc_fils > v_lines_fils then
    raise exception 'The discount (%) is more than the order is worth (%).',
      v_disc_fils / 100.0, v_lines_fils / 100.0
      using errcode = 'P0001';
  end if;

  -- The rate a manager set on this order (RUN-ME-38), else the
  -- customer's zone rate, else the default zone's, else the
  -- app-wide rate — orderVatRate in lib/orders-server.ts.
  select o.vat_rate_override into v_rate from public.orders o where o.id = p_order_id;
  if v_rate is null then
    select c.country_code into v_country from public.customers c where c.id = v_customer;
    select z.vat_rate into v_rate
    from public.zone_countries zc
    join public.zones z on z.id = zc.zone_id
    where zc.country_code = v_country
    limit 1;
    if v_rate is null then
      select z.vat_rate into v_rate from public.zones z order by z.is_default desc limit 1;
    end if;
    if v_rate is null then
      select s.vat_rate into v_rate from public.app_settings s limit 1;
    end if;
  end if;
  v_rate := coalesce(v_rate, 0.05);

  v_sub_fils := v_lines_fils - v_disc_fils;
  v_vat_fils := round(v_sub_fils * v_rate)::bigint;

  update public.orders
     set discount_amount = v_disc_fils / 100.0,
         subtotal        = v_sub_fils / 100.0,
         vat_amount      = v_vat_fils / 100.0,
         total           = (v_sub_fils + v_vat_fils) / 100.0,
         edited_at       = now(),
         edited_by_id    = v_user
   where id = p_order_id;
end;
$$;

revoke all on function public.manager_edit_order(uuid, jsonb, numeric) from public, anon;
grant execute on function public.manager_edit_order(uuid, jsonb, numeric) to authenticated;

-- ------------------------------------------------------------
-- 5. For the web's delete, restore and edit-grant routes
--
-- Gives an overseas order's stock back to its warehouse
-- (p_give_back = true) or takes it again (false, never below
-- zero). Returns the pieces moved. The routes decide WHETHER to
-- move (from the order's status), as they do for the UAE.
-- ------------------------------------------------------------
create or replace function public.order_warehouse_stock_move(p_order_id uuid, p_give_back boolean)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wh    uuid;
  v_move  record;
  v_have  integer;
  v_moved integer := 0;
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can move this order''s stock.' using errcode = '42501';
  end if;

  select o.stock_warehouse_id into v_wh
  from public.orders o
  where o.id = p_order_id
  for update;
  if not found then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_wh is null then
    raise exception 'This is a UAE order.' using errcode = '22023';
  end if;

  perform 1
  from public.products p
  where coalesce(p.stock_group_id, p.id) in (
    select coalesce(q.stock_group_id, q.id)
    from public.order_items i
    join public.products q on q.id = i.product_id
    where i.order_id = p_order_id
  )
  order by p.id
  for update of p;

  for v_move in
    select min(q.id::text)::uuid as product_id,
           sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as need
    from public.order_items i
    join public.products q on q.id = i.product_id
    where i.order_id = p_order_id
    group by coalesce(q.stock_group_id, q.id)
  loop
    continue when v_move.need <= 0;
    v_have := public.warehouse_shelf_qty(v_move.product_id, v_wh);
    if p_give_back then
      perform public.warehouse_shelf_write(v_move.product_id, v_wh, v_have + v_move.need);
      v_moved := v_moved + v_move.need;
    else
      perform public.warehouse_shelf_write(v_move.product_id, v_wh, greatest(0, v_have - v_move.need));
      v_moved := v_moved + least(v_have, v_move.need);
    end if;
  end loop;

  return v_moved;
end;
$$;

revoke all on function public.order_warehouse_stock_move(uuid, boolean) from public, anon;
grant execute on function public.order_warehouse_stock_move(uuid, boolean) to authenticated;
revoke all on function public.guard_order_stock_warehouse() from public, anon, authenticated;

notify pgrst, 'reload schema';


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'orders.stock_warehouse_id exists' as item,
       case when exists (select 1 from information_schema.columns
                         where table_schema = 'public' and table_name = 'orders'
                           and column_name = 'stock_warehouse_id')
            then 'OK' else 'MISSING' end as status
union all
select 'overseas orders hidden from staff',
       case when exists (select 1 from pg_policies
                         where schemaname = 'public' and tablename = 'orders'
                           and policyname = 'overseas orders are managers only'
                           and permissive = 'RESTRICTIVE')
            then 'OK' else 'MISSING' end
union all
select 'orders still has forced RLS',
       case when exists (select 1 from pg_class
                         where oid = 'public.orders'::regclass
                           and relrowsecurity and relforcerowsecurity)
            then 'OK' else 'CHECK' end
union all
select 'order country guard trigger',
       case when exists (select 1 from pg_trigger where tgname = 'orders_guard_stock_warehouse')
            then 'OK' else 'MISSING' end
union all
select 'order_warehouse_stock_move exists',
       case when exists (select 1 from pg_proc where proname = 'order_warehouse_stock_move')
            then 'OK' else 'MISSING' end;
