-- ============================================================
-- FGT Billing — the admin decides which actions need a
-- manager's approval, and the database enforces the answer.
--
-- Three things wait for a manager today:
--
--   • a customer change or new customer typed by a salesman or
--     the warehouse,
--   • the warehouse reopening an order that was already approved,
--   • a goods return.
--
-- Each gets a switch in Settings (admin only). ON is how the app
-- has always worked and is the default, so running this changes
-- nothing until an admin turns a switch off.
--
-- Switching one OFF does not just hide a button. What a salesman
-- or the warehouse may write is decided here, in the database:
--
--   • customers — a policy lets signed-in staff add and change
--     customers, but only while that switch is off.
--   • orders    — reopen_order_without_approval() does exactly
--     what "Grant edit" does (stock back on the shelf, order back
--     to picking), in one transaction, and refuses unless the
--     switch is off and the caller is the warehouse or a manager.
--   • returns   — approve_return_without_approval() puts the
--     goods back and credits the customer, in one transaction,
--     and refuses unless the switch is off and the caller is the
--     person who raised that return.
--
-- Only an admin can change the three switches; a trigger refuses
-- anybody else, whatever the app shows them.
--
-- Both apps work before this is run: with no switches to read
-- they treat all three as ON, which is today's behaviour.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The three switches. true = needs a manager, as now.
-- ------------------------------------------------------------
alter table public.app_settings
  add column if not exists customer_changes_need_approval boolean not null default true,
  add column if not exists order_edits_need_approval      boolean not null default true,
  add column if not exists goods_returns_need_approval    boolean not null default true;


-- ------------------------------------------------------------
-- 2. One question every rule below asks: is the caller an
--    active member of staff, and is this switch off?
--
--    security definer so it can read app_settings and users
--    whatever their own policies say; empty search_path so it
--    cannot be pointed at somebody else's tables. It only ever
--    reports on auth.uid(), which the caller cannot forge, and
--    answers false to anyone not signed in.
-- ------------------------------------------------------------
create or replace function public.may_skip_approval(what text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.users u
           where u.auth_user_id = auth.uid() and u.is_active
         )
     and coalesce((
           select case what
                    when 'customer_changes' then not s.customer_changes_need_approval
                    when 'order_edits'      then not s.order_edits_need_approval
                    when 'goods_returns'    then not s.goods_returns_need_approval
                    else false
                  end
           from public.app_settings s
           where s.id = 1
         ), false)
$$;

-- Supabase grants execute on every new function to anon by default, so it is
-- taken away by name: "from public" alone would leave that grant standing.
revoke all on function public.may_skip_approval(text) from public, anon;
grant execute on function public.may_skip_approval(text) to authenticated;


-- ------------------------------------------------------------
-- 3. Only an admin changes the switches.
--
--    app_settings is writable by managers too (the delivery
--    step, the theme), and RLS cannot tell one column from
--    another, so this is a trigger. The service role has no
--    auth.uid() and is let through: it is the server, and the
--    import tools use it.
-- ------------------------------------------------------------
create or replace function public.approval_switches_are_admin_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and (new.customer_changes_need_approval is distinct from old.customer_changes_need_approval
       or new.order_edits_need_approval      is distinct from old.order_edits_need_approval
       or new.goods_returns_need_approval    is distinct from old.goods_returns_need_approval)
     and not public.current_role_is('admin')
  then
    raise exception 'Only an admin can change which actions need approval.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists app_settings_approval_switches on public.app_settings;
create trigger app_settings_approval_switches
  before update on public.app_settings
  for each row execute function public.approval_switches_are_admin_only();


-- ------------------------------------------------------------
-- 4. Customers: staff may write them directly while the switch
--    is off. Policies add up, so nothing a manager can do today
--    is touched, and the moment the switch goes back on these
--    two stop matching anything.
-- ------------------------------------------------------------
drop policy if exists "staff add customers when no approval is needed" on public.customers;
create policy "staff add customers when no approval is needed" on public.customers
  for insert to authenticated
  with check (public.may_skip_approval('customer_changes'));

drop policy if exists "staff change customers when no approval is needed" on public.customers;
create policy "staff change customers when no approval is needed" on public.customers
  for update to authenticated
  using (public.may_skip_approval('customer_changes'))
  with check (public.may_skip_approval('customer_changes'));


-- ------------------------------------------------------------
-- 5. Orders: reopen an approved order without waiting.
--
--    The same effect as the manager's "Grant edit": what the
--    approval took off the shelf goes back, and the order drops
--    to 'picking' with its totals cleared for the next approval.
--    Done here rather than in either app because the warehouse
--    cannot write stock or order totals itself, and because
--    stock and status must move together or not at all.
-- ------------------------------------------------------------
create or replace function public.reopen_order_without_approval(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := public.current_app_user_id();
  v_status text;
begin
  if not public.may_skip_approval('order_edits') then
    raise exception 'Reopening an approved order needs a manager.' using errcode = '42501';
  end if;
  if not (public.current_role_is('warehouse') or public.current_role_is('manager')) then
    raise exception 'Only the warehouse or a manager can reopen an order.' using errcode = '42501';
  end if;

  -- Locked, so two people pressing the button cannot both put the stock back.
  select o.status::text into v_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if v_status is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  if v_status not in ('approved', 'edit_requested') then
    raise exception 'This order is not approved, so there is nothing to reopen.' using errcode = 'P0001';
  end if;

  update public.products p
     set stock_on_hand = coalesce(p.stock_on_hand, 0) + back.qty
    from (
      select i.product_id, sum(coalesce(i.picked_qty, i.ordered_qty, 0))::integer as qty
      from public.order_items i
      where i.order_id = p_order_id
      group by i.product_id
    ) back
   where p.id = back.product_id;

  update public.orders
     set status = 'picking', total = 0, subtotal = 0, vat_amount = 0
   where id = p_order_id;

  insert into public.order_status_log (order_id, changed_by, changed_at)
  values (p_order_id, v_user, now());
end;
$$;

revoke all on function public.reopen_order_without_approval(uuid) from public, anon;
grant execute on function public.reopen_order_without_approval(uuid) to authenticated;


-- ------------------------------------------------------------
-- 6. Returns: a return is final as soon as it is raised.
--
--    Only the person who raised it, only while it is pending,
--    only while the switch is off. Stock goes back for every
--    line and the return is marked approved in one transaction;
--    approved_by records who made it final, which here is the
--    person who raised it, because nobody else looked.
-- ------------------------------------------------------------
create or replace function public.approve_return_without_approval(p_grv_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := public.current_app_user_id();
  v_status    text;
  v_submitter uuid;
begin
  if not public.may_skip_approval('goods_returns') then
    raise exception 'A goods return needs a manager''s approval.' using errcode = '42501';
  end if;

  select g.status::text, g.submitted_by into v_status, v_submitter
  from public.grv_returns g
  where g.id = p_grv_id
  for update;

  if v_status is null then
    raise exception 'Return not found.' using errcode = 'P0002';
  end if;
  if v_submitter is distinct from v_user then
    raise exception 'Only the person who raised a return can finalise it.' using errcode = '42501';
  end if;
  -- Approving twice would put the stock back twice.
  if v_status = 'approved' then
    return;
  end if;

  update public.products p
     set stock_on_hand = greatest(0, coalesce(p.stock_on_hand, 0) + back.qty)
    from (
      select i.product_id, sum(i.qty)::integer as qty
      from public.grv_items i
      where i.grv_id = p_grv_id
      group by i.product_id
    ) back
   where p.id = back.product_id;

  update public.grv_returns
     set status = 'approved', approved_by = v_user
   where id = p_grv_id;
end;
$$;

revoke all on function public.approve_return_without_approval(uuid) from public, anon;
grant execute on function public.approve_return_without_approval(uuid) to authenticated;


-- Tell PostgREST about the new columns and functions now rather
-- than whenever its cache next refreshes.
notify pgrst, 'reload schema';
