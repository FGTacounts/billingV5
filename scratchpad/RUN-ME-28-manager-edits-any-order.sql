-- ============================================================
-- FGT Billing — a manager can change an order at any stage,
-- and the stock follows.
--
-- Owner's decision, 2026-09-25: a manager (or admin) may change
-- quantities, prices and discounts, and add or remove lines, on
-- an order at any status — approved, out for delivery and
-- delivered included. This replaces the 2026-09-21 rule that an
-- approved order is only changed through the edit-request flow.
--
-- What this adds:
--
--   • orders.discount_amount — a discount on the whole order,
--     in AED, taken off before VAT. 0 on every existing order,
--     so no figure moves when this is run.
--
--   • orders.line_order — the order the lines are listed in, as
--     the manager arranged them. A list of line ids; a line not
--     in it (a new one, or every line before anyone arranges)
--     comes after, in the order it always has. Kept on the order
--     rather than on each line because the web reads lines
--     through the order_items_safe view, whose definition lives
--     only in the database: adding a column to it means
--     rewriting a view that hides cost prices, sight unseen.
--
--   • manager_edit_order(order, changes, discount) — makes the
--     edit, in one transaction:
--       – the lines are changed, added, removed, picked,
--         unpicked or rearranged;
--       – if the order has already been approved (its stock is
--         already off the shelf) the shelf moves by exactly the
--         difference: a line taken off goes back, a quantity
--         raised comes off. A raise the shelf cannot cover is
--         refused, the same "nothing is sold from an empty
--         shelf" rule approval applies;
--       – subtotal, VAT and total are recomputed from the lines,
--         less the order discount, at the customer's zone rate;
--       – the order is stamped Edited.
--     Before approval nothing has come off the shelf yet, so only
--     the lines and totals change; approval deducts as it always
--     has.
--
-- Both apps keep working before this is run; they use it once it
-- exists.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The order-wide discount.
--
--    AED in a numeric column, like subtotal, vat_amount and total
--    beside it on the same row, and like payments.discount_amount
--    (RUN-ME-25). Never negative.
-- ------------------------------------------------------------
alter table public.orders
  add column if not exists discount_amount numeric not null default 0;

alter table public.orders
  drop constraint if exists orders_discount_not_negative;
alter table public.orders
  add constraint orders_discount_not_negative check (discount_amount >= 0);

comment on column public.orders.discount_amount is
  'Discount on the whole order, AED, taken off the line total before VAT. subtotal is already net of it.';

alter table public.orders
  add column if not exists line_order uuid[];

comment on column public.orders.line_order is
  'order_items ids in the order the manager arranged them. Lines not listed come after.';


-- ------------------------------------------------------------
-- 2. The edit itself.
--
--    p_changes is a JSON array, applied in order:
--
--      {"op":"set", "id":"<line id>", "qty":3, "unit_price":12.5}
--          change a line; either field may be left out.
--          qty goes to the picked quantity if the line has one,
--          otherwise the ordered quantity — the figure the
--          invoice prints.
--
--      {"op":"set", "product_id":"<uuid>", "qty":2, "unit_price":9}
--          no id: a new line. sku, description and cost are
--          taken from the product. On an order past picking the
--          new line is marked picked at that quantity, so the
--          invoice shows it.
--
--      {"op":"remove", "id":"<line id>"}
--
--      {"op":"pick", "id":"<line id>", "qty":4}
--      {"op":"pick", "id":"<line id>", "qty":null}
--          mark a line picked at that quantity, or unpick it.
--          Unpicked, the invoice falls back to the ordered
--          quantity, so on an approved order unpicking a short-
--          picked line takes the rest off the shelf.
--
--      {"op":"arrange", "ids":["<line id>", ...]}
--          the order the lines are listed in.
--
--    p_discount: the order-wide discount in AED, or null to leave
--    it as it is.
--
--    security definer because the stock and cost columns are not
--    writable (or, for cost, readable) by staff directly; the
--    function checks the caller is a manager or admin itself.
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
  if not (public.current_role_is('manager') or public.current_role_is('admin')) then
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
      update public.order_items
         set picked_qty  = case when c ? 'qty' and v_line.picked_qty is not null
                                then (c->>'qty')::integer else picked_qty end,
             ordered_qty = case when c ? 'qty' and v_line.picked_qty is null
                                then (c->>'qty')::integer else ordered_qty end,
             unit_price  = case when c ? 'unit_price'
                                then (c->>'unit_price')::numeric else unit_price end
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
      insert into public.order_items
        (order_id, product_id, sku, description, ordered_qty, picked_qty, unit_price, unit_cost)
      values
        (p_order_id, v_product.id, v_product.sku, coalesce(v_product.description, v_product.sku),
         v_qty, case when v_past_pick then v_qty end,
         coalesce((c->>'unit_price')::numeric, v_product.price, 0), v_product.cost);

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

-- Supabase grants execute on every new function to anon by default, so it is
-- taken away by name: "from public" alone would leave that grant standing.
revoke all on function public.manager_edit_order(uuid, jsonb, numeric) from public, anon;
grant execute on function public.manager_edit_order(uuid, jsonb, numeric) to authenticated;
