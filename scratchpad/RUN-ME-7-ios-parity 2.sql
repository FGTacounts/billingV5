-- ============================================================
-- FGT Billing — what the iOS app needs from the database.
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
--
-- Safe to run more than once: every statement is "if not exists",
-- "create or replace", or drops its policy before creating it.
--
-- Checked against the live database on 3 Sep 2026.
-- Assumes RUN-ME-all-pending.sql has been run (it provides
-- current_app_user_id() and current_role_is()).
-- ============================================================


-- ------------------------------------------------------------
-- 1. products_safe  (IMPORTANT — the phone's product list is empty)
--
-- RUN-ME-4 took products.cost away from signed-in users. That is
-- right, but the phone read the raw table and named cost in its
-- select, so the whole request was refused and the catalogue came
-- back empty for everyone. This view is the products twin of
-- order_items_safe, which already exists: a manager sees the real
-- cost figures, everyone else sees blanks. The phone reads this
-- first and falls back to the raw table (without cost) if it is
-- missing.
--
-- The four manager-entered figures are cost data, so they are
-- masked the same way.
-- ------------------------------------------------------------
-- Deliberately NOT written in terms of current_role_is(): if that helper is
-- still the broken version (it referenced a dropped column), every product
-- read would fail. This asks the users table directly, so the view stands on
-- its own whatever else has or hasn't been run.
create or replace function public.viewer_sees_cost()
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
      and u.role in ('manager', 'admin')
  )
$$;

grant execute on function public.viewer_sees_cost() to anon, authenticated;

create or replace view public.products_safe as
select
  p.id, p.sku, p.description, p.price, p.stock_on_hand, p.default_qty,
  p.rack_location, p.barcode, p.is_active, p.created_at, p.updated_at,
  p."Product_category",
  case when public.viewer_sees_cost() then p.cost end                        as cost,
  case when public.viewer_sees_cost() then p.vac_override end                as vac_override,
  case when public.viewer_sees_cost() then p.vac_china_override end          as vac_china_override,
  case when public.viewer_sees_cost() then p.stock_arrival_date end          as stock_arrival_date,
  case when public.viewer_sees_cost() then p.stock_holding_days_override end as stock_holding_days_override
from public.products p;

grant select on public.products_safe to authenticated;


-- ------------------------------------------------------------
-- 1b. Settings columns that were never added
--
-- Both apps ask for these on nearly every page and the database
-- answers "column does not exist" every time. Nothing breaks —
-- each read falls back — but the Delivery stage cannot be turned
-- off, photos go to hard-coded folders, and the browser console
-- fills with errors. Verified missing on 3 Sep 2026.
-- ------------------------------------------------------------
alter table public.app_settings add column if not exists delivery_enabled boolean not null default true;
alter table public.app_settings add column if not exists cheque_drive_folder_id text;
alter table public.app_settings add column if not exists invoice_proof_drive_folder_id text;

update public.app_settings
   set cheque_drive_folder_id        = coalesce(cheque_drive_folder_id,        '1z_GV1W4YQDflS8IBQeNNvXvfGo5yEG2Q'),
       invoice_proof_drive_folder_id = coalesce(invoice_proof_drive_folder_id, '1HNKQrQ9F5ypv5AJAeBpof56LWzQ3unKC');


-- ------------------------------------------------------------
-- 2. Customer change requests
--
-- Same file as RUN-ME-6. A salesman or the warehouse proposes a
-- customer change; a manager applies or turns it down from the
-- Inbox. Both apps read and write this table now.
-- ------------------------------------------------------------
create table if not exists public.customer_change_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete cascade,
  payload jsonb not null,
  requested_by uuid not null references public.users(id),
  status text not null default 'pending',
  reviewed_by uuid references public.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.customer_change_requests enable row level security;
alter table public.customer_change_requests force row level security;

drop policy if exists "read customer change requests" on public.customer_change_requests;
create policy "read customer change requests"
  on public.customer_change_requests for select to authenticated
  using (public.current_role_is('manager') or requested_by = public.current_app_user_id());

drop policy if exists "raise customer change requests" on public.customer_change_requests;
create policy "raise customer change requests"
  on public.customer_change_requests for insert to authenticated
  with check (requested_by = public.current_app_user_id() and status = 'pending');

drop policy if exists "review customer change requests" on public.customer_change_requests;
create policy "review customer change requests"
  on public.customer_change_requests for update to authenticated
  using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));

create index if not exists customer_change_requests_pending
  on public.customer_change_requests (status, created_at desc);


-- ------------------------------------------------------------
-- 3. Payment extension requests
--
-- Referenced by the web's Payments page and Order detail since the
-- first build, but never created, so the section stayed empty. A
-- salesman asks for more time on an invoice; a manager decides.
-- ------------------------------------------------------------
create table if not exists public.payment_extension_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  requested_by uuid not null references public.users(id),
  requested_due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  approved_by uuid references public.users(id),
  reason text,
  created_at timestamptz not null default now()
);

alter table public.payment_extension_requests enable row level security;
alter table public.payment_extension_requests force row level security;

drop policy if exists "read extension requests" on public.payment_extension_requests;
create policy "read extension requests"
  on public.payment_extension_requests for select to authenticated
  using (public.current_role_is('manager') or requested_by = public.current_app_user_id());

drop policy if exists "raise extension requests" on public.payment_extension_requests;
create policy "raise extension requests"
  on public.payment_extension_requests for insert to authenticated
  with check (requested_by = public.current_app_user_id() and status = 'pending');

drop policy if exists "decide extension requests" on public.payment_extension_requests;
create policy "decide extension requests"
  on public.payment_extension_requests for update to authenticated
  using (public.current_role_is('manager'))
  with check (public.current_role_is('manager'));


-- ------------------------------------------------------------
-- 4. Payment delay notes from a phone
--
-- The web writes these under its admin key. The phone writes them
-- as the signed-in user, so it needs a row rule of its own: you
-- may add a note in your own name; managers and the author may
-- read it.
-- ------------------------------------------------------------
alter table public.payment_delay_notes enable row level security;

drop policy if exists "add own delay notes" on public.payment_delay_notes;
create policy "add own delay notes"
  on public.payment_delay_notes for insert to authenticated
  with check (added_by = public.current_app_user_id());

drop policy if exists "read delay notes" on public.payment_delay_notes;
create policy "read delay notes"
  on public.payment_delay_notes for select to authenticated
  using (public.current_role_is('manager') or added_by = public.current_app_user_id());


-- ------------------------------------------------------------
-- 5. Clearing one's own inbox
--
-- The web clears notifications under its admin key; the phone does
-- it as the signed-in user. Only your own rows.
-- ------------------------------------------------------------
drop policy if exists "clear own notifications" on public.notifications;
create policy "clear own notifications"
  on public.notifications for delete to authenticated
  using (user_id = public.current_app_user_id());


-- ------------------------------------------------------------
-- 6. News posts  (iOS-only feature — optional)
--
-- The phone's Inbox has a "Post news" feature that writes to this
-- table, which has never existed, so posting quietly did nothing.
-- The web app has no news feature; this only makes the phone's
-- existing one work. Skip this section if you would rather not
-- have it.
-- ------------------------------------------------------------
create table if not exists public.news_posts (
  id uuid primary key default gen_random_uuid(),
  posted_by uuid not null references public.users(id),
  author text not null,
  author_role text not null,
  title text not null default '',
  body text not null default '',
  created_at timestamptz not null default now()
);

alter table public.news_posts enable row level security;
alter table public.news_posts force row level security;

drop policy if exists "read news" on public.news_posts;
create policy "read news"
  on public.news_posts for select to authenticated using (true);

drop policy if exists "post news" on public.news_posts;
create policy "post news"
  on public.news_posts for insert to authenticated
  with check (posted_by = public.current_app_user_id());

drop policy if exists "remove news" on public.news_posts;
create policy "remove news"
  on public.news_posts for delete to authenticated
  using (posted_by = public.current_app_user_id() or public.current_role_is('manager'));


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'products_safe view' as item,
       case when exists (select 1 from information_schema.views
                          where table_schema='public' and table_name='products_safe')
            then 'OK' else 'MISSING' end as status
union all
select 'cost stays hidden from staff',
       case when exists (select 1 from pg_proc where proname='viewer_sees_cost')
            then 'OK' else 'MISSING' end
union all
select 'delivery stage setting',
       case when exists (select 1 from information_schema.columns
                          where table_name='app_settings' and column_name='delivery_enabled')
            then 'OK' else 'MISSING' end
union all
select 'customer change requests',
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='customer_change_requests')
            then 'OK' else 'MISSING' end
union all
select 'payment extension requests',
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='payment_extension_requests')
            then 'OK' else 'MISSING' end
union all
select 'delay notes from phones',
       case when exists (select 1 from pg_policies
                          where tablename='payment_delay_notes' and policyname='add own delay notes')
            then 'OK' else 'MISSING' end
union all
select 'clear own inbox',
       case when exists (select 1 from pg_policies
                          where tablename='notifications' and policyname='clear own notifications')
            then 'OK' else 'MISSING' end
union all
select 'news posts',
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='news_posts')
            then 'OK' else 'MISSING' end;
