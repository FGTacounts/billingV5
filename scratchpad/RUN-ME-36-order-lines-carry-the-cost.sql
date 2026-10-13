-- ============================================================
-- FGT Billing — every new order line carries the article's cost
-- price, whoever made the order and from whichever app.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run,
-- with the role selector on `postgres`. Safe to run more than
-- once. Adds one trigger function, and fills the cost in on the
-- lines that were saved without one (206 lines, 25 Sep–12 Oct
-- 2026, all for articles that do have a cost).
--
-- Found 2026-10-13: an order opened on the web showed Gross
-- profit "—" and no GP column on its lines. The lines had no
-- unit_cost in the database, though every one of their articles
-- has a cost. Every affected order was made by a salesman on the
-- phone since 3 Oct. The phone can only write a line's cost when
-- the signed-in user is a manager — a salesman is not allowed to
-- read cost prices (RUN-ME-4), so for them it writes nothing.
-- The web's create route fills the cost under the server's own
-- key, which is why web orders were fine.
--
-- The cost snapshot belongs in the database, where it can be
-- taken whatever client or role inserts the line:
--
--   • BEFORE INSERT on order_items: a line with no unit_cost gets
--     the article's cost at that moment (the same snapshot the web
--     route and manager_edit_order take). A line sent WITH a cost
--     keeps it. An article with no cost leaves the line uncosted,
--     as before — GP then leaves that line out, and says so.
--   • security definer, because the inserting salesman may not
--     read products.cost; the function reads it for them and
--     never hands it back (the line's unit_cost stays hidden from
--     them by RUN-ME-4 as before).
--
-- Nothing on orders is touched, so no sale is re-dated (the
-- updated_at trap is on the orders table, not order_items).
-- ============================================================

-- ------------------------------------------------------------
-- 1. The snapshot, on every new line
-- ------------------------------------------------------------
create or replace function public.order_items_snapshot_cost()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost numeric;
begin
  if new.unit_cost is null and new.product_id is not null then
    select p.cost into v_cost
      from public.products p
     where p.id = new.product_id;
    if v_cost is not null and v_cost > 0 then
      new.unit_cost := v_cost;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.order_items_snapshot_cost() from public, anon;

drop trigger if exists order_items_snapshot_cost on public.order_items;
create trigger order_items_snapshot_cost
  before insert on public.order_items
  for each row execute function public.order_items_snapshot_cost();

-- ------------------------------------------------------------
-- 2. The lines already saved without a cost
--
-- They get the article's cost as it is today. For a line from
-- the last three weeks that is the cost it would have been given
-- at the time, or within a few fils of it. A line whose article
-- has no cost is left alone.
-- ------------------------------------------------------------
update public.order_items oi
   set unit_cost = p.cost
  from public.products p
 where p.id = oi.product_id
   and oi.unit_cost is null
   and p.cost is not null
   and p.cost > 0;

-- ------------------------------------------------------------
-- 3. Proof. Expect: trigger present, and the second query 0 (or
--    only lines whose article has no cost).
-- ------------------------------------------------------------
select tgname, tgenabled
  from pg_trigger
 where tgrelid = 'public.order_items'::regclass
   and tgname = 'order_items_snapshot_cost';

select count(*) as lines_still_without_cost,
       count(*) filter (where p.cost is not null and p.cost > 0) as of_which_article_has_a_cost
  from public.order_items oi
  left join public.products p on p.id = oi.product_id
 where oi.unit_cost is null;
