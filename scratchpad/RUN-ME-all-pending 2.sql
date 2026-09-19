-- ============================================================
-- FGT Billing — everything still pending, in one file.
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
--
-- Safe to run more than once: every statement is either
-- "if not exists" or "create or replace". Running it twice
-- changes nothing the second time.
--
-- Checked against the live database on 29 Aug 2026.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Permission helpers  (SECURITY)
--
-- These two functions are what the database uses to work out who
-- you are and what you are allowed to see. Until they are correct,
-- the database is not enforcing permissions on its own — the app
-- is doing all the enforcing. Run this first.
-- ------------------------------------------------------------
-- Famlist Billing — repair current_app_user_id() and current_role_is().
--
-- THE PROBLEM
-- Both functions still look up public.users by a column called `auth_id`.
-- That column was renamed to `auth_user_id` at some point, so both functions
-- now fail outright:
--
--     select current_app_user_id();
--     ERROR:  column "auth_id" does not exist   (SQLSTATE 42703)
--
-- Every RLS policy that calls either one fails the same way, which is why a
-- plain query against `expenses` returns a 42703 error instead of rows. The
-- app has been working around this by doing all its reads and writes through
-- the service role in server-side routes, with the caller's role re-checked
-- in the route itself — so nothing is broken for users today.
--
-- But it does mean the RLS layer is currently inert: it is not adding any
-- protection on top of those route checks, and anyone who later writes a
-- direct client query, or turns a policy back on, gets an error rather than
-- the enforcement they think they're getting. This restores it.
--
-- Verify afterwards with:
--     select public.current_app_user_id();          -- null when not signed in, no error
--     select public.current_role_is('manager');     -- false when not signed in, no error
--
-- Safe to re-run. The signatures are unchanged, so the existing policies keep
-- working without being touched.
--
-- CHECK THIS FIRST. I could confirm through the API that the argument is
-- named `r` and that 'admin' is a valid role value, but not the exact name of
-- the enum type. Run this and confirm it prints `current_role_is(r user_role)`
-- — if the type is called something other than `user_role`, substitute that
-- name everywhere below before running the rest. Getting it wrong would
-- create a second, unused overload rather than replacing the broken one, and
-- the policies would go on failing.
--
--     select p.proname, pg_get_function_arguments(p.oid) as args
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     where n.nspname = 'public'
--       and p.proname in ('current_role_is', 'current_app_user_id');

-- The signed-in user's row id in public.users, or null when not signed in.
-- `stable` (not `volatile`) so the planner can call it once per query rather
-- than once per row — this runs inside every policy check.
-- `security definer` so the lookup isn't itself blocked by RLS on users,
-- with an empty search_path so the function can't be hijacked by a caller
-- putting their own `users` table earlier on the path.
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id
  from public.users u
  where u.auth_user_id = auth.uid()
  limit 1
$$;

-- True when the signed-in user holds the given role. Kept as a single-arg
-- function named `r` so the existing policies and PostgREST calls that
-- reference it keep resolving.
--
-- Treats admin as satisfying a 'manager' check: the app's own route guards
-- all use `role === "manager" || role === "admin"`, and without this an
-- admin session would be refused by every manager-gated policy.
create or replace function public.current_role_is(r public.user_role)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.auth_user_id = auth.uid()
      and u.is_active
      -- `users.role` is a text column, while the parameter is the user_role
      -- enum, and Postgres has no text = user_role operator. Compared as text
      -- on both sides. The parameter keeps the enum type so existing policies
      -- calling current_role_is(user_role) still resolve to this function.
      and (u.role = r::text or (r::text = 'manager' and u.role = 'admin'))
  )
$$;

-- Both are called from RLS policies evaluated as the requesting role, so
-- those roles need execute. security definer is what makes this safe: the
-- functions only ever report on auth.uid(), which the caller cannot forge.
grant execute on function public.current_app_user_id() to anon, authenticated;
grant execute on function public.current_role_is(public.user_role) to anon, authenticated;


-- ------------------------------------------------------------
-- 2. Adjustable salesman goals
--
-- Adds a monthly goal to each salesman, and a company-wide
-- default for anyone without one. This is what switches on the
-- goal boxes in Settings -> Users. Until it runs, every salesman
-- is measured against the same figure.
-- ------------------------------------------------------------
-- Famlist Billing — per-salesman monthly sales targets.
--
-- THE PROBLEM
-- Every goal figure in the app came from a constant in the code:
--
--     export const DEFAULT_MONTHLY_TARGET = 100000;
--
-- It is used in a dozen places across the Dashboard, the Sales page and the
-- salesman drill-down, which means every salesman is shown the same AED
-- 100,000 goal and every "% to goal" is measured against it. Your own
-- mockup disagrees — it shows Ajnaz, Shamseer, Saleem and Sajjad on 100,000
-- but Bilal on 10,000 — and there was nowhere in the database to store that
-- difference. This adds it.
--
-- A null target on a user means "use the company default", so you only have
-- to set the people who differ.
--
-- Safe to re-run.

alter table public.users
  add column if not exists monthly_target numeric(14, 2);

comment on column public.users.monthly_target is
  'This salesman''s monthly sales goal in AED. Null = fall back to app_settings.default_monthly_target.';

alter table public.app_settings
  add column if not exists default_monthly_target numeric(14, 2) not null default 100000;

comment on column public.app_settings.default_monthly_target is
  'Company-wide monthly sales goal, used for any salesman with no target of their own.';

-- A negative goal is meaningless and would invert every percentage that
-- reads from it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_monthly_target_nonneg') then
    alter table public.users
      add constraint users_monthly_target_nonneg
      check (monthly_target is null or monthly_target >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_default_target_nonneg') then
    alter table public.app_settings
      add constraint app_settings_default_target_nonneg
      check (default_monthly_target >= 0);
  end if;
end $$;


-- ------------------------------------------------------------
-- 3. Which orders count as sales
--
-- Lets you choose, in Settings, the point at which an order
-- starts counting towards reports.
-- ------------------------------------------------------------
-- §Global: "Admin can adjust at what point of the order/payment flow orders
-- affect reports." Everything was hardcoded to status = 'delivered'; this
-- column makes the threshold configurable from Settings.
--
-- Valid values: 'approved' | 'delivering' | 'delivered'. Defaults to
-- 'delivered', i.e. exactly the behaviour before this change, so running
-- this migration on its own changes no number anywhere.
alter table public.app_settings
  add column if not exists reports_from_status text not null default 'delivered';

alter table public.app_settings
  drop constraint if exists app_settings_reports_from_status_check;

alter table public.app_settings
  add constraint app_settings_reports_from_status_check
  check (reports_from_status in ('approved', 'delivering', 'delivered'));


-- ------------------------------------------------------------
-- 4. Customer country and payer details
--
-- The zone tables already exist; these are the two customer
-- columns that go with them. Country decides which VAT rate an
-- invoice uses, so without this every customer falls back to
-- the default zone.
-- ------------------------------------------------------------
-- Zones (§Global: "The admin adds zones. For each zone he can set specific
-- data entries such as vat for that specific zone. All countries linked to
-- that zone follow this. By default it is in one zone. He can set the
-- currency for each specific country, or just use a general currency for
-- that zone.")

create table if not exists public.zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  vat_rate numeric not null default 0.15,
  currency_code text not null default 'AED',
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

-- Only one zone may be the default (the "By default it is in one zone" zone
-- every country falls back to until an Admin explicitly assigns it).
create unique index if not exists zones_only_one_default
  on public.zones (is_default)
  where is_default;

-- Seeds a Default zone at today's real VAT rate, so existing orders/invoices
-- keep computing the same VAT they already do until an Admin changes it.
insert into public.zones (name, vat_rate, currency_code, is_default)
select 'Default', 0.15, 'AED', true
where not exists (select 1 from public.zones where is_default);

-- Country -> zone mapping. currency_code is nullable — null means "use the
-- zone's currency_code" (§Global: "or just use a general currency for that
-- zone").
create table if not exists public.zone_countries (
  country_code text primary key,
  country_name text not null,
  zone_id uuid not null references public.zones(id) on delete cascade,
  currency_code text,
  created_at timestamptz not null default now()
);

-- Which country a customer belongs to, for zone/VAT/currency resolution.
-- No country on a customer = falls back to the Default zone.
alter table public.customers add column if not exists country_code text;

-- Persists the cheque payer's details (§Customers: "bank name and customer
-- details should be saved/remembered for next time") — no dedicated column
-- existed for this before; it was silently dropped on save.
alter table public.payments add column if not exists payer_details text;

-- §Orders: "the customer's last-billed price for that item should be the
-- saved/suggested default" and "same last-used-discount reuse mechanic for
-- per-product discounts". Both tables were referenced throughout the app
-- code (NewOrderSheet's useLastPrices/addProduct/applyOrderDiscount) but
-- never actually existed — this is why "Use last prices" never had
-- anything to apply. Written to at order approval (customer_prices) and
-- whenever a Manager sets a whole-order discount (customer_discounts).
create table if not exists public.customer_prices (
  customer_id uuid not null references public.customers(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  price numeric not null,
  updated_at timestamptz not null default now(),
  primary key (customer_id, product_id)
);

create table if not exists public.customer_discounts (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  discount_type text not null check (discount_type in ('percent', 'amount')),
  discount_value numeric not null,
  updated_at timestamptz not null default now()
);


-- ------------------------------------------------------------
-- 4b. Staff phone number
--
-- Settings -> Account already lets someone save a phone number, and the
-- invoice prints the salesman's number under "Salesman No." — but the
-- column it needs was never added, so both quietly do nothing.
-- ------------------------------------------------------------
alter table public.users add column if not exists phone text;


-- ------------------------------------------------------------
-- 5. Invoice numbering  (IMPORTANT — fixes a live fault)
--
-- The version currently in the database hands out a number that
-- has already been used. Approving an order today would either be
-- refused, or produce two invoices sharing one number.
--
-- This replaces it with the corrected version and adds a uniqueness
-- rule so two invoices can never share a number again.
-- ------------------------------------------------------------
-- Famlist Billing — gapless, race-free invoice numbering.
--
-- WHAT THIS FIXES
-- The number was assigned in JavaScript at approval: read every existing
-- invoice number, take the highest in JS, write +1. Two managers approving
-- at the same moment both read the same highest number and both write it.
-- Duplicate invoice numbers are an audit finding in most jurisdictions.
--
-- WHY NOT A POSTGRES SEQUENCE
-- A sequence is the usual answer to that race, and it was my first draft.
-- But nextval() does not roll back — if a number is taken and the
-- transaction then fails, that number is gone and the series has a hole.
-- You have said you do not want gaps, so a sequence is the wrong tool here.
--
-- Instead this takes a transaction-scoped advisory lock, reads the current
-- highest number, and adds one. Two callers cannot interleave, and a failed
-- transaction leaves the counter exactly where it was, because the counter
-- IS the data. That is gapless and race-free.
--
-- The trade-off is that invoice numbering serialises: two approvals happening
-- at the exact same instant queue rather than run in parallel. At your volume
-- that costs microseconds and is the correct trade for a tax document series.
--
-- WHEN THE NUMBER IS ASSIGNED
-- At approval, when the invoice is actually issued — not at order creation.
-- Assigning at creation would mean a cancelled order consumed a number and
-- left a gap, which is the thing you are avoiding.
--
-- Safe to re-run.

create or replace function public.assign_invoice_number(order_id_param uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing text;
  start_setting bigint;
  next_number bigint;
begin
  -- Idempotent: an order that already has a number keeps it. The app calls
  -- this on approval, and approval can legitimately be retried.
  select o.invoice_number into existing
    from public.orders o
   where o.id = order_id_param
     for update;

  if not found then
    raise exception 'Order % does not exist', order_id_param;
  end if;

  if existing is not null and existing <> '' then
    return existing;
  end if;

  -- One arbitrary but fixed key, so every caller assigning an invoice number
  -- waits on the same lock. Released automatically at end of transaction,
  -- including on rollback.
  perform pg_advisory_xact_lock(hashtext('famlist_invoice_number'));

  select coalesce(invoice_start_number, 4300) into start_setting
    from public.app_settings
   order by id
   limit 1;

  -- Highest number actually issued, or one below the configured start if
  -- nothing has been issued yet. Cast explicitly: invoice_number is text, and
  -- a text sort would rank '9999' above '10000'.
  select greatest(
           coalesce(max((invoice_number)::bigint), 0),
           coalesce(start_setting, 4300) - 1
         )
    into next_number
    from public.orders
   where invoice_number ~ '^[0-9]+$';

  next_number := next_number + 1;

  update public.orders
     set invoice_number = next_number::text
   where id = order_id_param;

  return next_number::text;
end $$;

grant execute on function public.assign_invoice_number(uuid) to authenticated, service_role;

-- Two orders must never share a number. This is what makes a duplicate
-- impossible rather than merely unlikely: if any code path ever regresses to
-- assigning numbers itself, the database refuses the write.
-- Verified before writing this: there are no duplicates today, so it applies
-- cleanly.
create unique index if not exists orders_invoice_number_unique
  on public.orders (invoice_number)
  where invoice_number is not null;

-- If an earlier version of this file created a sequence, it is unused now.
-- Left in place rather than dropped, in case anything else came to depend on
-- it; it does no harm. To remove it:
--   drop sequence if exists public.invoice_number_seq;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'salesman goals'  as item,
       case when exists (select 1 from information_schema.columns
                          where table_name='users' and column_name='monthly_target')
            then 'OK' else 'MISSING' end as status
union all
select 'report stage',
       case when exists (select 1 from information_schema.columns
                          where table_name='orders' and column_name='reports_from_status')
            then 'OK' else 'MISSING' end
union all
select 'customer country',
       case when exists (select 1 from information_schema.columns
                          where table_name='customers' and column_name='country_code')
            then 'OK' else 'MISSING' end
union all
select 'payer details',
       case when exists (select 1 from information_schema.columns
                          where table_name='customers' and column_name='payer_details')
            then 'OK' else 'MISSING' end
union all
select 'staff phone number',
       case when exists (select 1 from information_schema.columns
                          where table_name='users' and column_name='phone')
            then 'OK' else 'MISSING' end
union all
select 'invoice numbering',
       case when exists (select 1 from pg_proc
                          where proname='assign_invoice_number')
            then 'OK' else 'MISSING' end
union all
select 'no duplicate invoice numbers',
       case when exists (select 1 from pg_indexes
                          where indexname='orders_invoice_number_unique')
            then 'OK' else 'MISSING' end;
