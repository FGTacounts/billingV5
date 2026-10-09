-- ============================================================
-- FGT Billing — approving an order takes its stock once, and
-- taking an approval back gives it back once.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. Changes no table and no row; it
-- only adds two functions.
--
-- Found 2026-10-07, checking that a 12-piece order takes 12 off
-- the shelf (it does). What could make it take 24:
--
--   • The phone approved from its own list without asking the
--     database whether the order was still waiting. An order
--     already approved on the web, still showing Packed on a
--     phone that had not refreshed, was approved again and its
--     stock taken a second time. "Approve again to issue a
--     number" on the phone did the same.
--   • The web asked, but the asking, the taking and the marking
--     approved were three separate calls, so two approvals of the
--     same order within a second could both get through.
--
-- Taking an approval back had the same shape in reverse, and on
-- the web it also put stock onto a product that keeps no count
-- (stock_on_hand null), turning "not counted" into 12 — approval
-- never took anything from it.
--
-- Both moves now happen inside one transaction, with the order
-- row locked, so whichever call comes second finds the order
-- already moved and touches no stock.
--
--   approve_order_take_stock(order, allow_short, subtotal, vat, total)
--     -> {"result":"approved"}
--        {"result":"already_approved"}   nothing written
--        {"result":"short","short":[{"sku","need","have"},…]}
--                                        nothing written
--
--   unapprove_order_give_stock(order)
--     -> {"result":"unapproved","restored":<pieces>}
--        {"result":"not_approved","status":"<status>"}
--                                        nothing written
--
-- The rules are the ones both apps already used (owner,
-- 2026-09-27): every line counts at its picked quantity, or what
-- was ordered if it was never picked; products sharing a shelf
-- (RUN-ME-18) draw from one figure; a shelf with no count is not
-- checked, not taken from and not given back to; approving
-- anyway takes a short shelf to zero, never below. The billed
-- figures are still worked out by the app (zone VAT, the order
-- discount) and handed in, exactly as they were written before.
--
-- Relies on RUN-ME-8 (stock floor), RUN-ME-18 (shared shelves)
-- and RUN-ME-29 (current_user_is_admin), all live.
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
  select o.status::text into v_status
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
begin
  if not (public.current_role_is('manager') or public.current_user_is_admin()) then
    raise exception 'Only a manager can take an approval back.' using errcode = '42501';
  end if;

  select o.status::text into v_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_status is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status <> 'approved' then
    return jsonb_build_object('result', 'not_approved', 'status', v_status);
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
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'approve_order_take_stock exists' as item,
       case when exists (select 1 from pg_proc where proname = 'approve_order_take_stock')
            then 'OK' else 'MISSING' end as status
union all
select 'unapprove_order_give_stock exists',
       case when exists (select 1 from pg_proc where proname = 'unapprove_order_give_stock')
            then 'OK' else 'MISSING' end
union all
select 'stock floor trigger (RUN-ME-8) is live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_floor')
            then 'OK' else 'MISSING' end
union all
select 'shared-stock mirror trigger (RUN-ME-18) is live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_mirror')
            then 'OK' else 'MISSING' end;
