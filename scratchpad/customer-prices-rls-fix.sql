-- All four tables from the first migration were created with Row Level
-- Security on and no policy, so every logged-in app user's read came back
-- empty even though the rows existed (confirmed live for both
-- customer_prices — "Use last prices" still showed the list price, not the
-- sticky price — and zones — the seeded Default zone was invisible to the
-- browser client). Matches the rest of this app's tables, which rely on
-- requiring login at the app layer rather than per-table RLS.

alter table public.customer_prices disable row level security;
alter table public.customer_discounts disable row level security;
alter table public.zones disable row level security;
alter table public.zone_countries disable row level security;

-- §Orders: "Manager has complete flexibility over an order at any stage
-- (invoice number, customer, salesman, PO number editable)". The invoice
-- PDF has printed a "P.O. No." column since before this session — always
-- blank, because this column never existed to hold a value for it.
alter table public.orders add column if not exists po_number text;
