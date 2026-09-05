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

select 'customer change requests' as item,
       case when exists (select 1 from information_schema.tables
                          where table_schema='public' and table_name='customer_change_requests')
            then 'OK' else 'MISSING' end as status;
