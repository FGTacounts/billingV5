# FGT Billing — live Supabase schema, 12 Sep 2026

Read off the live database, not off the code: fetched from PostgREST's own
schema document with the service-role key, then every doubtful column probed
individually. Where the code and the database disagree, the database is what
is written below and the disagreement is listed at the end.

25 objects: 23 tables and 2 views (`products_safe`, `order_items_safe`, both
read-only). Every uuid primary key defaults to `gen_random_uuid()`, so leave
the id column out of an import file unless you are preserving existing ids.

Money is `numeric` in this database, not integer minor units. That is what is
live; do not convert values on the way in.

## Enums — an import fails on any other spelling

| Type | Values |
|---|---|
| `order_status` | draft, pending, rejected, accepted, waiting, picking, packed, approved, edit_requested, delivering, delivered, cancelled |
| `payment_status` | pending, confirmed |
| `cheque_status` | pending, cleared, bounced, returned |
| `grv_status` | pending, approved |
| `expense_type` | fixed, variable, purchase |
| `push_platform` | web, ios |

`users.role` is plain text, not an enum: salesman, manager, warehouse, admin.
So are `customer_change_requests.status` and
`payment_extension_requests.status` (pending/approved/rejected) and
`customer_discounts.discount_type` (percent/amount) — text, unconstrained,
spell them the same way the app does.

## Two columns are capitalised

`products."Product_category"` and `payments."Delay_reason"`. In SQL they need
double quotes; in a CSV header they need that exact casing. Everything else in
the schema is lower snake case.

## Tables

Legend: **PK** primary key · *NN* not null · → foreign key

### users — 8 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| auth_user_id | uuid | nullable — the matching `auth.users.id` |
| username | text | *NN* |
| full_name | text | *NN* |
| role | text | *NN* |
| email | text | nullable |
| phone | text | nullable |
| is_active | boolean | *NN* default true |
| monthly_target | numeric | nullable — null falls back to app_settings.default_monthly_target |
| preferences | jsonb | nullable — per-user UI state, safe to import as null |
| created_at | timestamptz | *NN* default now() |
| updated_at | timestamptz | *NN* default now() |

A row here is not a login. The login lives in `auth.users` and is joined by
`auth_user_id`; importing users leaves them unable to sign in until that is
filled (see docs/IOS-CREATING-USERS.md).

### customers — 356 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| name | text | *NN* |
| code | text | *NN* — **unique**, the natural import key |
| group_name | text | nullable |
| district | text | nullable |
| address | text | nullable |
| phone | text | nullable |
| vat_number | text | nullable |
| country_code | text | nullable — ISO alpha-2, resolves the zone |
| overdue_threshold_days | integer | *NN* default 90 |
| salesman_id | uuid | nullable → users.id |
| is_active | boolean | *NN* default true |
| created_at | timestamptz | *NN* default now() |
| updated_at | timestamptz | *NN* default now() |

### products — 1306 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| sku | text | *NN* — **unique**, the natural import key |
| description | text | nullable — this is the product's name; there is no separate name column |
| price | numeric | *NN* default 0 |
| cost | numeric | *NN* default 0 — manager/admin only, see docs/why-cost-prices-are-hidden.md |
| stock_on_hand | integer | *NN* default 0 |
| default_qty | integer | *NN* default 1 |
| rack_location | text | nullable |
| barcode | text | nullable |
| "Product_category" | text | nullable |
| vac_override | numeric | nullable — manager-entered landing cost, overrides the derived figure |
| vac_china_override | numeric | nullable |
| stock_arrival_date | date | nullable — overrides the latest GRN date |
| stock_holding_days_override | integer | nullable |
| stock_group_id | uuid | nullable — products sharing an id share one stock figure |
| is_active | boolean | *NN* default true |
| created_at | timestamptz | *NN* default now() |
| updated_at | timestamptz | *NN* default now() |

A trigger clamps `stock_on_hand` to 0 on insert and update: a negative number
in an import file silently becomes zero, it does not error.

### orders — 535 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| invoice_number | text | nullable — **unique where not null**; text, so cast before sorting |
| status | order_status | *NN* default 'draft' |
| salesman_id | uuid | *NN* → users.id |
| customer_id | uuid | nullable → customers.id |
| new_customer_note | text | nullable — an order for a customer not yet in the book |
| customer_snapshot | jsonb | nullable — the customer as they were when the order was placed |
| salesman_note | text | nullable — manager → salesman |
| manager_note | text | nullable — salesman or warehouse → manager |
| warehouse_note | text | nullable — manager → warehouse |
| po_number | text | nullable |
| subtotal | numeric | *NN* default 0 |
| vat_amount | numeric | *NN* default 0 |
| total | numeric | *NN* default 0 |
| extended_due_date | date | nullable |
| rejected_at | timestamptz | nullable |
| edited_at | timestamptz | nullable |
| edited_by_id | uuid | nullable → users.id |
| deleted_at | timestamptz | nullable — trash, not deletion |
| deleted_by | uuid | nullable → users.id |
| deleted_from_status | text | nullable |
| created_at | timestamptz | *NN* default now() |
| updated_at | timestamptz | *NN* default now() |

Invoice numbers: `assign_invoice_number(order_id)` takes an advisory lock and
returns `max(invoice_number::bigint) + 1`, floored at
`app_settings.invoice_start_number`. Because the counter is the data itself,
importing historical invoice numbers needs no counter reset — the next
assignment steps past whatever you loaded. Duplicates are refused by the
unique index.

### order_items — 7 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| order_id | uuid | *NN* → orders.id |
| product_id | uuid | nullable → products.id |
| sku | text | *NN* — snapshot, kept even if the product is renamed |
| description | text | *NN* — snapshot |
| ordered_qty | integer | *NN* default 1 |
| picked_qty | integer | nullable |
| unit_price | numeric | *NN* default 0 |
| unit_cost | numeric | nullable |
| picked_by_id | uuid | nullable → users.id |
| picked_at | timestamptz | nullable |
| created_at | timestamptz | *NN* default now() |

Seven rows against 535 orders: the order history was loaded without its lines.
If line-level history matters, this is the table that needs the import.

### payments — 22 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| customer_id | uuid | *NN* → customers.id |
| collector_id | uuid | *NN* → users.id |
| amount | numeric | *NN* |
| status | payment_status | *NN* default 'pending' |
| cheque_number | text | nullable |
| cheque_bank | text | nullable |
| cheque_date | timestamptz | nullable |
| cheque_status | cheque_status | nullable |
| cheque_photo_ref | text | nullable — a Google Drive file id |
| payer_details | text | nullable |
| "Delay_reason" | text | nullable |
| notes | text | nullable |
| created_at | timestamptz | *NN* default now() |
| updated_at | timestamptz | *NN* default now() |

### payment_orders — 22 rows
Which payment paid down which invoice. PK is the pair.

| Column | Type | |
|---|---|---|
| payment_id | uuid | **PK** *NN* |
| order_id | uuid | **PK** *NN* |
| allocated_amount | numeric | *NN* |

### order_status_log — 29 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| order_id | uuid | *NN* |
| changed_by | uuid | *NN* |
| changed_at | timestamptz | *NN* default now() |

It records that something changed and by whom — there is no from/to status
column live, so it cannot reconstruct a status history.

### expenses — 3 rows
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| type | expense_type | *NN* |
| category | text | nullable |
| description | text | nullable |
| amount | numeric | *NN* |
| date | date | *NN* default CURRENT_DATE |
| expense_date | date | *NN* default CURRENT_DATE |
| logged_by | uuid | *NN* — who typed it in, always a manager |
| salesman_id | uuid | nullable → users.id — whose expense it is |
| notes | text | nullable |
| updated_at | timestamptz | *NN* default now() |

Both `date` and `expense_date` exist and both are NOT NULL. The app reads and
writes `date`; `expense_date` is a leftover that will quietly take
CURRENT_DATE if an import omits it. Set both to the same value.

### purchases — 1 row
| Column | Type | |
|---|---|---|
| id | uuid | **PK** *NN* default gen_random_uuid() |
| product_id | uuid | *NN* |
| grn_date | date | *NN* default CURRENT_DATE |
| qty | integer | *NN* |
| uom | text | nullable |
| china_cost | numeric | nullable |
| landing_cost | numeric | nullable |
| total_cost | numeric | nullable |
| po_reference | text | nullable |

Goods received. This is where VAC and stock-arrival figures come from when the
product's override columns are null — so a purchase history import changes what
the product screens show.

### zones — 1 row · zone_countries — 0 rows
`zones`: id uuid **PK**, name text *NN*, vat_rate numeric *NN* default 0.15,
currency_code text *NN* default 'AED', is_default boolean *NN* default false,
created_at timestamptz *NN* default now().

`zone_countries`: country_code text **PK** *NN*, country_name text *NN*,
zone_id uuid *NN* → zones.id, currency_code text nullable, created_at
timestamptz *NN* default now().

`customers.country_code` points here by convention but carries no foreign key,
so it will accept a country you have not loaded.

### customer_prices — 0 rows
customer_id uuid **PK** → customers.id, product_id uuid **PK** →
products.id, price numeric *NN*, updated_at timestamptz *NN* default now().
Per-customer agreed price; written on approval, upserted on the pair.

### customer_discounts — 0 rows
customer_id uuid **PK** → customers.id, discount_type text *NN*,
discount_value numeric *NN*, updated_at timestamptz *NN* default now().

### grv_returns — 1 row · grv_items — 1 row
`grv_returns`: id uuid **PK**, customer_id uuid *NN*, submitted_by uuid *NN*,
status grv_status *NN* default 'pending', approved_by uuid nullable,
created_at timestamptz *NN* default now().

`grv_items`: id uuid **PK**, grv_id uuid *NN* → grv_returns.id, product_id
uuid *NN*, qty integer *NN*, unit_value numeric *NN*.

### The rest — all empty
- **notifications** — id **PK**, user_id *NN* → users.id, title *NN*, body *NN*, type *NN*, ref_id uuid nullable, is_read *NN* default false, created_at *NN* default now()
- **news_posts** — id **PK**, posted_by *NN* → users.id, author *NN*, author_role *NN*, title *NN* default '', body *NN* default '', created_at *NN* default now()
- **push_tokens** — id **PK**, user_id uuid *NN*, platform push_platform *NN*, token text *NN*, updated_at *NN* default now()
- **payment_delay_notes** — id **PK**, order_id *NN*, note *NN*, added_by *NN*, created_at *NN* default now()
- **payment_extension_requests** — id **PK**, order_id *NN* → orders.id, requested_by *NN* → users.id, requested_due_date date *NN*, status text *NN* default 'pending', approved_by nullable → users.id, reason nullable, created_at *NN* default now()
- **customer_change_requests** — id **PK**, customer_id nullable → customers.id, payload jsonb *NN*, requested_by *NN* → users.id, status text *NN* default 'pending', reviewed_by nullable → users.id, reviewed_at nullable, created_at *NN* default now()

### app_settings — 1 row, and it must stay one row
id integer **PK** default 1. Update it, never insert into it.

| Column | Type | Default |
|---|---|---|
| overdue_threshold_days | integer | 30 |
| vat_rate | numeric | 0.15 |
| invoice_start_number | integer *NN* | 4300 |
| reports_from_status | text *NN* | 'delivered' |
| default_monthly_target | numeric *NN* | 100000 |
| delivery_enabled | boolean *NN* | true |
| accent_theme | text | null |
| google_maps_api_key | text | null |
| product_photos_drive_folder_id | text | null |
| private_uploads_drive_folder_id | text | null |
| cheque_drive_folder_id | text | null |
| invoice_proof_drive_folder_id | text | null |

The four Drive folder ids are where photos, cheques and invoice PDFs live.
The Maps key and folder ids are read server-side only.

### The two views
`products_safe` and `order_items_safe` are read-only. Never import into them.
They exist so a non-manager session can read a row without the cost column;
`order_items_safe` adds `picked_by_name` and drops `created_at`.

## Import order

Foreign keys force this sequence:

1. `auth.users` (via the Supabase Auth API, not SQL) — only if the imported staff need logins
2. `users`
3. `zones` → `zone_countries`
4. `customers` (needs users for salesman_id)
5. `products`
6. `customer_prices`, `customer_discounts` (need customers + products)
7. `purchases`
8. `orders` (needs users + customers)
9. `order_items`, `order_status_log`, `payment_delay_notes`, `payment_extension_requests`
10. `payments` → `payment_orders`
11. `grv_returns` → `grv_items`
12. `expenses`, `notifications`, `news_posts`, `push_tokens`
13. `app_settings` — update the existing row

## Before you import

- **Sign in, or use the service role.** Every table has RLS with FORCE and
  nothing is readable or writable anonymously. The Supabase dashboard's SQL
  editor and CSV importer run as a privileged role, so both work; the anon key
  will not.
- **Leave uuid ids out** unless you are deliberately preserving them, and if
  you are, import parents before children so the references resolve.
- **Match `code` and `sku`** to reuse the app's own upsert path
  (`onConflict: code` for customers, `onConflict: sku` for products) instead of
  creating duplicates.
- **Timestamps are timestamptz in UTC.** A bare `2026-09-12 08:00` is read in
  the database's timezone; write `2026-09-12T08:00:00Z`.
- **The app's own importers** (`/api/customers/import`, `/api/products/import`,
  `/api/orders/import`, `/api/expenses/import`) already do the column aliasing
  in lib/importAliases.ts and run as the service role. For spreadsheet data
  they are usually the better route than raw SQL.

## Where the code and the database disagree

Verified by probing each column, today.

1. **`orders.edited_by` does not exist; `orders.edited_by_id` does.**
   `scratchpad/RUN-ME-19-order-edited-stamp.sql` adds `edited_by`, and
   `lib/orders-server.ts:74` writes to it — that update fails live.
   `lib/queries/orders.ts:71` selects it too. Either run RUN-ME-19 or point
   the code at `edited_by_id`. Worth fixing separately.
2. **`jobs` does not exist** — `scratchpad/RUN-ME-23-job-queue.sql` has not
   been run, and `lib/jobs.ts` / `lib/queries/inbox.ts` query it.
3. **`route_visits` does not exist** — `scratchpad/RUN-ME-21-visit-log.sql`
   has not been run; the planning screens query it.
4. **`users.monthly_bonus` and `users.incentive_note` do not exist** —
   `scratchpad/RUN-ME-20-salesman-bonus.sql` has not been run.
5. **`products.stock_floor` does not exist**, and does not need to: RUN-ME-8
   implements the floor as a trigger, not a column, and its other half
   (`expenses.salesman_id`) is live, so that file has been run.
6. **No delivery columns on `orders`** — no `delivered_at`,
   `delivery_proof_url` or `invoice_pdf_url`. This one is not a disagreement:
   they were dropped deliberately and the code already allows for it
   (`lib/queries/dashboard.ts:100` uses `updated_at` instead, and delivery
   proof lives in Google Drive). `app_settings.delivery_enabled` is live.
   Do not add these columns back on the strength of an import file that has
   them.
7. **No `stock_groups` table** — `products.stock_group_id` is a bare uuid used
   as a grouping tag, with nothing to join to.
8. **`order_items_safe` still holds write privileges from PUBLIC.**
   `npm run test:tenancy` fails on exactly this, today. Nothing can actually
   be written — a view with no INSTEAD OF trigger refuses the row — but the
   privilege is there, and both safe views run as their owner, so it should
   not be. `scratchpad/RUN-ME-24-safe-views-take-two.sql` is the fix and has
   not been run. RUN-ME-22 revoked from `anon` and `authenticated`, which
   takes nothing away when the grant is held by PUBLIC.

## Pending SQL, in the order the files were written

Not run against the live database as of today: RUN-ME-19 (order edited
stamp), RUN-ME-20 (salesman bonus), RUN-ME-21 (visit log), RUN-ME-23 (job
queue), RUN-ME-24 (safe views are read-only — this one fixes a failing
tenancy test). Everything numbered below 19 is live, judged by the columns
each one adds.
