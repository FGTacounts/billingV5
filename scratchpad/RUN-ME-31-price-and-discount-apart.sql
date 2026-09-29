-- ============================================================
-- FGT Billing — an order line keeps its price and its discount
-- apart.
--
-- Owner, 2026-09-29: "when editing the price. it shows the
-- discount. The discount is separate from the price."
--
-- Until now a line stored only what it charges (unit_price), and
-- its Disc % was worked out as the gap between that and the
-- product's list price. So a line with 10% off a 10.00 article
-- showed a price of 9.00, and 9.00 is what came up to edit; typing
-- a new price lost the discount.
--
-- What this adds:
--
--   • order_items.price_before_discount — the line's price before
--     its discount: the list price, the customer's last price, or
--     what a manager typed. unit_price stays what the line
--     charges, and is still the only figure any total, invoice,
--     statement or report adds up. The Disc % is the gap between
--     the two. Null on every line written before this, and on any
--     line nobody has discounted: those read exactly as before
--     (the list price when the line charges less, else what it
--     charges). Nothing is backfilled, so no figure moves when
--     this is run.
--
--   • A trigger that keeps it at or above unit_price: a line
--     charged more than its price before discount has no discount,
--     so the price before discount is raised to match. This also
--     covers a phone that has not been updated yet and writes
--     unit_price alone.
--
--   • manager_edit_order learns "price_before_discount" on a line
--     change. A change to unit_price that does not give one keeps
--     the line's price before discount, so a percentage off every
--     line, a round subtotal or a margin shows as discount instead
--     of moving the price. Otherwise the function is RUN-ME-28's,
--     unchanged (with RUN-ME-29's admin check).
--
-- Both apps keep working before this is run: they fall back to the
-- old behaviour and use the column once it exists.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The column. numeric, in AED, like unit_price beside it.
-- ------------------------------------------------------------
alter table public.order_items
  add column if not exists price_before_discount numeric;

alter table public.order_items
  drop constraint if exists order_items_price_before_discount_not_negative;
alter table public.order_items
  add constraint order_items_price_before_discount_not_negative
  check (price_before_discount is null or price_before_discount >= 0);

comment on column public.order_items.price_before_discount is
  'The line''s price before its discount, AED. unit_price is what it charges; the gap is the discount. Null: the list price when unit_price is below it, else unit_price.';

-- Staff read order_items column by column (RUN-ME-4 hid unit_cost
-- that way), so a new column is unreadable until it is named here.
-- Signed-in users only; anon has nothing on this table (RUN-ME-13).
grant select (price_before_discount) on public.order_items to authenticated;


-- ------------------------------------------------------------
-- 2. Never below what the line charges.
-- ------------------------------------------------------------
create or replace function public.order_items_price_before_discount_floor()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.price_before_discount is not null
     and new.price_before_discount < new.unit_price then
    new.price_before_discount := new.unit_price;
  end if;
  return new;
end;
$$;

revoke all on function public.order_items_price_before_discount_floor() from public, anon;

drop trigger if exists order_items_price_before_discount_floor on public.order_items;
create trigger order_items_price_before_discount_floor
  before insert or update of unit_price, price_before_discount on public.order_items
  for each row execute function public.order_items_price_before_discount_floor();


-- ------------------------------------------------------------
-- 3. manager_edit_order, as RUN-ME-28 wrote it, plus
--    price_before_discount on "set":
--
--      {"op":"set", "id":"<line id>", "unit_price":9, "price_before_discount":10}
--      {"op":"set", "product_id":"<uuid>", "qty":2, "unit_price":9, "price_before_discount":10}
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
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can change this order.' using errcode = '42501';
  end if;

  -- Locked, so two edits to one order cannot both move the same stock.
  select o.status::text, o.customer_id into v_status, v_customer
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
  if v_deducted then
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

  -- The customer's zone rate, else the default zone's, else the
  -- app-wide rate — resolveVatRate in lib/queries/zones.ts.
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
-- What you should see: three rows, each saying OK.
-- ------------------------------------------------------------
select 'price_before_discount column' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema = 'public' and table_name = 'order_items'
                            and column_name = 'price_before_discount')
            then 'OK' else 'MISSING' end as status
union all
select 'staff can read it',
       case when has_column_privilege('authenticated', 'public.order_items', 'price_before_discount', 'SELECT')
            then 'OK' else 'MISSING' end
union all
select 'manager_edit_order knows it',
       case when (select prosrc from pg_proc where proname = 'manager_edit_order'
                   and pronamespace = 'public'::regnamespace) like '%price_before_discount%'
            then 'OK' else 'MISSING' end;
