# Hiding cost prices from staff

Run once, in Supabase → SQL Editor — the statements are in
`scratchpad/RUN-ME-4-hide-cost-prices.sql`.

A column-level `revoke` on its own does nothing here: `authenticated` holds
`SELECT` on the whole table, and a table-level grant covers every column,
including ones later revoked. The privilege has to be taken away at the
table and given back column by column.

To undo, restore the table-level grant:

```sql
grant select on public.products    to authenticated;
grant select on public.order_items to authenticated;
```

## What it fixes

A salesman signed in to the app could send a request straight to the
database and read every product's cost price and every order line's unit
cost — the margin on all 1,300 products.

The app itself is careful: every screen reads cost through
`order_items_safe`, which shows a manager the real figure and everyone
else a blank. Both were verified. The underlying tables were simply
readable around that view, so the careful path was optional.

`products_safe`, the equivalent view for products, does not exist in this
database, which is why the app reads the raw `products` table in eighteen
places.

## Why taking the columns away is safe

Checked every call site before writing this:

- `products.cost` is only ever read by the server, under the admin key.
  These grants do not apply to that key.
- `order_items.unit_cost` is only read through `order_items_safe`, which
  is a view and keeps working.

Verified on 29 Aug 2026 by signing in as a real salesman account and
reading both columns directly.

Stock levels and the customer list are deliberately left readable — both
were decisions, not oversights.
