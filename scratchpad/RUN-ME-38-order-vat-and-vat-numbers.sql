-- ============================================================
-- FGT Billing — an order's own VAT, and which VAT numbers its
-- invoice prints ("Additional changes" on an order).
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run,
-- with the role selector on `postgres`. Safe to run more than
-- once. Adds three columns to orders, a guard on who may set
-- them, and teaches manager_edit_order the order's own rate.
-- Changes no row.
--
-- Owner's request, 2026-10-22: "in an order add an option called
-- additional changes, where the manager/admin can edit payment
-- terms, remove or change VAT", plus "VAT no of the customer and
-- our VAT no, removal or adding", due date and order discount.
-- Payment terms (RUN-ME-37), the due date (extended_due_date)
-- and the order discount (RUN-ME-28) already have columns.
--
--   • orders.vat_rate_override — numeric, a fraction like
--     zones.vat_rate (0.05 is 5%). Empty for every order: empty
--     means the customer's zone rate, exactly as today. 0 means
--     no VAT on this order. Between 0 and 1.
--   • orders.invoice_customer_vat_no — what the invoice prints as
--     the customer's VAT No. Empty (null): the customer's own, as
--     today. An empty string: none printed. Anything else: that
--     number, on this invoice only. At most 30 characters.
--   • orders.invoice_shows_our_trn — true for every order. False
--     leaves our TRN off this order's invoice.
--   • Only a manager or admin may set any of the three. A
--     salesman's own order cannot be saved with them changed,
--     from either app or straight through the API (the anon key
--     is public). The server's own key and this editor are not
--     stopped — nobody is signed in there.
--   • manager_edit_order (last written by RUN-ME-31) takes the
--     order's own rate before the customer's zone rate. The rest
--     of the function is unchanged, line for line.
--
-- Adding a column fires no row trigger, so no sale is re-dated.
-- ============================================================

alter table public.orders
  add column if not exists vat_rate_override numeric;
alter table public.orders
  add column if not exists invoice_customer_vat_no text;
alter table public.orders
  add column if not exists invoice_shows_our_trn boolean not null default true;

alter table public.orders
  drop constraint if exists orders_vat_rate_override_range;
alter table public.orders
  add constraint orders_vat_rate_override_range
  check (vat_rate_override is null or (vat_rate_override >= 0 and vat_rate_override <= 1));

alter table public.orders
  drop constraint if exists orders_invoice_customer_vat_no_length;
alter table public.orders
  add constraint orders_invoice_customer_vat_no_length
  check (invoice_customer_vat_no is null or char_length(invoice_customer_vat_no) <= 30);

comment on column public.orders.vat_rate_override is
  'VAT on this order as a fraction (0.05 = 5%), set by a manager. Null: the customer''s zone rate. 0: no VAT.';
comment on column public.orders.invoice_customer_vat_no is
  'Customer VAT No printed on this order''s invoice. Null: the customer''s own. Empty string: none.';
comment on column public.orders.invoice_shows_our_trn is
  'False leaves the company TRN off this order''s invoice.';

-- ------------------------------------------------------------
-- Who may set them: a manager or admin. Raises, never rewrites,
-- so nothing on the row (updated_at included) is touched.
-- ------------------------------------------------------------
create or replace function public.guard_order_additional_changes()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- The server's own key and the SQL editor: nobody signed in.
  if (select auth.uid()) is null then
    return new;
  end if;
  if public.current_role_is('manager') or public.current_user_is_admin() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.vat_rate_override is not null
       or new.invoice_customer_vat_no is not null
       or new.invoice_shows_our_trn is distinct from true then
      raise exception 'Only a manager can change an order''s VAT or VAT numbers.' using errcode = '42501';
    end if;
  elsif new.vat_rate_override is distinct from old.vat_rate_override
     or new.invoice_customer_vat_no is distinct from old.invoice_customer_vat_no
     or new.invoice_shows_our_trn is distinct from old.invoice_shows_our_trn then
    raise exception 'Only a manager can change an order''s VAT or VAT numbers.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_guard_additional_changes on public.orders;
create trigger orders_guard_additional_changes
  before insert or update on public.orders
  for each row execute function public.guard_order_additional_changes();

-- ------------------------------------------------------------
-- manager_edit_order: the order's own rate first.
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
-- PostgREST learns about the new columns straight away.
notify pgrst, 'reload schema';

-- ------------------------------------------------------------
-- Proof. Expect four rows, each saying OK, and 0 orders changed.
-- ------------------------------------------------------------
select 'three new columns' as item,
       case when (select count(*) from information_schema.columns
                   where table_schema = 'public' and table_name = 'orders'
                     and column_name in ('vat_rate_override', 'invoice_customer_vat_no', 'invoice_shows_our_trn')) = 3
            then 'OK' else 'MISSING' end as status
union all
select 'only a manager may set them',
       case when exists (select 1 from pg_trigger
                          where tgname = 'orders_guard_additional_changes'
                            and tgrelid = 'public.orders'::regclass)
            then 'OK' else 'MISSING' end
union all
select 'manager_edit_order knows the order''s own rate',
       case when (select prosrc from pg_proc where proname = 'manager_edit_order'
                   and pronamespace = 'public'::regnamespace) like '%vat_rate_override%'
            then 'OK' else 'MISSING' end
union all
select 'manager_edit_order still knows price_before_discount',
       case when (select prosrc from pg_proc where proname = 'manager_edit_order'
                   and pronamespace = 'public'::regnamespace) like '%price_before_discount%'
            then 'OK' else 'MISSING' end;

select count(*) filter (where vat_rate_override is not null
                           or invoice_customer_vat_no is not null
                           or invoice_shows_our_trn is not true) as orders_changed
  from public.orders;
