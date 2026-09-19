-- Famlist Billing — hand-editable VAC / VAC (China) / stock arrival & holding
-- days on products.
--
-- Until now these four figures were DERIVED and shown read-only:
--   VAC        = landing_cost from the product's most recent purchase (GRN)
--   VAC China  = china_cost   from that same purchase
--   SAD        = days since that GRN date
--   SHD        = stock_on_hand / (average monthly units sold, last 3 months)
--
-- These columns do NOT replace that. They are OVERRIDES: when a manager types
-- a value it wins; when the column is null the app keeps computing the figure
-- from purchase and sales history exactly as before. That way a catalogue of
-- 1000+ SKUs stays automatically correct without anyone typing anything, and
-- the manager can still correct any individual product the data gets wrong.
--
-- Safe to re-run.

alter table public.products
  add column if not exists vac_override numeric(12, 2),
  add column if not exists vac_china_override numeric(12, 2),
  -- A real date, not a day count: "stock arrival days" is the gap between
  -- arrival and today, so storing the count would silently go stale as soon
  -- as the day rolls over. The app shows the day count and edits the date.
  add column if not exists stock_arrival_date date,
  add column if not exists stock_holding_days_override integer;

comment on column public.products.vac_override is
  'Manager-entered landing cost (AED). Overrides the value derived from the latest purchase when not null.';
comment on column public.products.vac_china_override is
  'Manager-entered China cost. Overrides the value derived from the latest purchase when not null.';
comment on column public.products.stock_arrival_date is
  'Manager-entered stock arrival date. Overrides the latest GRN date when not null; the app displays days-since.';
comment on column public.products.stock_holding_days_override is
  'Manager-entered stock holding days. Overrides stock_on_hand / avg monthly sales when not null.';

-- Guard against negatives, which are meaningless for all four and would
-- otherwise silently produce nonsense margins downstream.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_vac_override_nonneg') then
    alter table public.products
      add constraint products_vac_override_nonneg check (vac_override is null or vac_override >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_vac_china_override_nonneg') then
    alter table public.products
      add constraint products_vac_china_override_nonneg check (vac_china_override is null or vac_china_override >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'products_shd_override_nonneg') then
    alter table public.products
      add constraint products_shd_override_nonneg check (stock_holding_days_override is null or stock_holding_days_override >= 0);
  end if;
end $$;

-- No view change is needed. products_safe no longer exists in this project
-- (confirmed against the live API — it returns "Could not find the table
-- public.products_safe"). Cost masking for non-Manager sessions happens
-- server-side instead, in fetchProductsServer, which picks its column list
-- from the caller's real role. The four columns above are cost figures, so
-- that same server-side masking has been extended to cover them — a salesman
-- session never receives them, verified the same way cost and stock_on_hand
-- were.
