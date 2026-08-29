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
