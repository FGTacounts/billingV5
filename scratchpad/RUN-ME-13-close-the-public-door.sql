-- ============================================================
-- FGT Billing — close the door that is currently open to anyone
-- holding the app's public key.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. It grants nothing new; it only
-- takes away access that should never have been there.
--
-- WHY
--
-- The public key is embedded in the web app and the phone app,
-- so it is exactly that: public. Tested against the live
-- database on 4 Sep 2026 with nothing but that key and no
-- login, these came back with real rows:
--
--   purchases          china_cost, landing_cost, total_cost
--   products_safe      the whole catalogue
--   order_items_safe   every order line and its price
--   payment_orders     who paid what against which invoice
--   grv_returns        customer returns
--   grv_items          returned lines and their value
--   order_status_log   order activity
--   zones              VAT configuration
--
-- An anonymous INSERT into `zones` also succeeded (the test row
-- was removed again). Everything else — orders, customers,
-- products, payments, users, expenses, app_settings — correctly
-- returned nothing.
--
-- Nothing in either app talks to the database before signing
-- in: login goes through Supabase Auth, not through the data
-- API. So the anonymous role needs no access at all.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The anonymous role loses its keys to the data API
-- ------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke usage on schema public from anon;

-- Anything created later should not hand them back.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;


-- ------------------------------------------------------------
-- 2. The two "safe" views follow the caller's own permissions
--
-- A view runs as its owner unless told otherwise, which is how
-- products_safe and order_items_safe were handing out rows that
-- the tables underneath them would have refused. security_invoker
-- makes them obey the reader's own row rules.
-- ------------------------------------------------------------
alter view public.products_safe set (security_invoker = true);
alter view public.order_items_safe set (security_invoker = true);


-- ------------------------------------------------------------
-- 3. Row security on the tables that had none
--
-- Each policy is written from what the apps actually do, so
-- nothing that works today stops working:
--   • everyone signed in reads;
--   • the writes each role already performs stay possible;
--   • purchases — which is cost data — becomes manager-only.
--
-- If any screen misbehaves after this, the one-line undo is
--   alter table public.<name> disable row level security;
-- and tell me which screen.
-- ------------------------------------------------------------

-- Payment allocations: read by every screen that ages a balance;
-- written when a payment is logged; removed when an order is
-- deleted (which is itself gated in the app).
alter table public.payment_orders enable row level security;
alter table public.payment_orders force row level security;
drop policy if exists "read payment allocations" on public.payment_orders;
create policy "read payment allocations" on public.payment_orders
  for select to authenticated using (true);
drop policy if exists "write payment allocations" on public.payment_orders;
create policy "write payment allocations" on public.payment_orders
  for insert to authenticated with check (true);
drop policy if exists "release payment allocations" on public.payment_orders;
create policy "release payment allocations" on public.payment_orders
  for delete to authenticated using (true);

-- Who moved an order, and when.
alter table public.order_status_log enable row level security;
alter table public.order_status_log force row level security;
drop policy if exists "read status log" on public.order_status_log;
create policy "read status log" on public.order_status_log
  for select to authenticated using (true);
drop policy if exists "add to status log" on public.order_status_log;
create policy "add to status log" on public.order_status_log
  for insert to authenticated with check (true);
drop policy if exists "clear status log" on public.order_status_log;
create policy "clear status log" on public.order_status_log
  for delete to authenticated using (public.current_role_is('manager'));

-- Goods returns: anyone signed in raises one, a manager decides.
alter table public.grv_returns enable row level security;
alter table public.grv_returns force row level security;
drop policy if exists "read returns" on public.grv_returns;
create policy "read returns" on public.grv_returns
  for select to authenticated using (true);
drop policy if exists "raise returns" on public.grv_returns;
create policy "raise returns" on public.grv_returns
  for insert to authenticated with check (true);
drop policy if exists "decide returns" on public.grv_returns;
create policy "decide returns" on public.grv_returns
  for update to authenticated using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

alter table public.grv_items enable row level security;
alter table public.grv_items force row level security;
drop policy if exists "read return lines" on public.grv_items;
create policy "read return lines" on public.grv_items
  for select to authenticated using (true);
drop policy if exists "add return lines" on public.grv_items;
create policy "add return lines" on public.grv_items
  for insert to authenticated with check (true);

-- Purchases carry landing and China cost. Manager and admin only,
-- the same rule as every other cost figure in the app.
alter table public.purchases enable row level security;
alter table public.purchases force row level security;
drop policy if exists "read purchases" on public.purchases;
create policy "read purchases" on public.purchases
  for select to authenticated using (public.current_role_is('manager'));
drop policy if exists "write purchases" on public.purchases;
create policy "write purchases" on public.purchases
  for all to authenticated using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

-- VAT zones: everyone signed in needs to read the rate; only a
-- manager changes it. (An anonymous insert into this table
-- succeeded before today.)
alter table public.zones enable row level security;
alter table public.zones force row level security;
drop policy if exists "read zones" on public.zones;
create policy "read zones" on public.zones
  for select to authenticated using (true);
drop policy if exists "manage zones" on public.zones;
create policy "manage zones" on public.zones
  for all to authenticated using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

alter table public.zone_countries enable row level security;
alter table public.zone_countries force row level security;
drop policy if exists "read zone countries" on public.zone_countries;
create policy "read zone countries" on public.zone_countries
  for select to authenticated using (true);
drop policy if exists "manage zone countries" on public.zone_countries;
create policy "manage zone countries" on public.zone_countries
  for all to authenticated using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));


-- ------------------------------------------------------------
-- Check it worked.
--
-- "row security on" should say OK for every table listed.
-- Then sign in to the web app and open Products, Orders,
-- Payments and Reports once — if anything is empty that should
-- not be, tell me which screen before doing anything else.
-- ------------------------------------------------------------
select c.relname as table_name,
       case when c.relrowsecurity then 'OK' else 'STILL OPEN' end as row_security,
       case when c.relforcerowsecurity then 'forced' else '-' end as forced
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('payment_orders','order_status_log','grv_returns','grv_items',
                     'purchases','zones','zone_countries','orders','order_items',
                     'customers','products','payments','users','expenses','app_settings')
 order by c.relrowsecurity, c.relname;
