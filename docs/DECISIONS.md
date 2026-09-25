# Decisions

`YYYY-MM-DD — Decision — Reason — Alternatives rejected`

Everything here was a judgement call rather than an obvious reading of the
spec. Read this before changing any of it.

---

## 2026-09-03/04 — Bringing the iOS app in line with the web app

The two apps share one Supabase project, so a disagreement between them is
not a cosmetic difference: it is two answers to the same question about the
same money. These entries are the ones where the phone was made to follow
the web app rather than the other way round.

2026-09-03 — The phone reads products through a new `products_safe` view,
falling back to the raw table without `cost` — Its product query named
`cost`, and staff sessions are no longer granted that column (the cost-price
lockdown took the table grant away and gave the columns back one by one).
PostgREST refuses the whole request over one forbidden column, so the
catalogue came back empty for every role, which also emptied the article
picker and every screen built on it — Rejected: dropping cost from the query
entirely (a manager legitimately sees cost and gross profit on the phone);
rejected reading cost through the server (the phone has no admin key, and it
must not).

2026-09-03 — Order notes are routed by RECIPIENT on the phone, as the
database and the web app already treat them — `salesman_note` means "for the
salesman", but the phone was writing the salesman's own note into it and
reading the manager's reply out of `manager_note`. Every note was therefore
delivered to the wrong person, and a manager's reply appeared to the
salesman as their own text — Rejected: changing the web app to match the
phone, which would have inverted the meaning of three columns that already
hold live data.

2026-09-03 — Invoice numbers are issued only at approval, by
`assign_invoice_number()` — The phone assigned one at order creation, so a
cancelled or rejected order burned a number and left a hole in the series,
and two phones creating orders at once could collide. A tax-document series
must be gapless — Rejected: a Postgres sequence (does not roll back, so a
failed transaction still leaves a hole).

2026-09-03 — A manager's "Accept" writes `waiting`, not `accepted` — The
warehouse's Waiting queue reads `waiting`; the phone wrote `accepted`, so an
order a manager had accepted on their phone did not appear for the warehouse
on the web until someone touched it again — Rejected: widening the web's
queue to include `accepted` (it already treats the two as one stage for
display; the writing side should still agree with the web's `acceptOrder`).

2026-09-03 — Granting an edit request reverses the stock deduction — The
phone only changed the status. Re-approving afterwards deducted every line a
second time, so stock drifted down by the size of the order each time an
edit was granted — Rejected: leaving stock alone and correcting by hand.

2026-09-03 — Order lines are edited in place instead of deleted and
re-inserted — The phone replaced every un-picked line on each save, which
issued new row ids and threw away the `unit_cost` snapshot taken at order
time. Gross profit for that order became unrecoverable, and a concurrent
picker's tick could land on a row that no longer existed — Rejected: keeping
the replace and re-snapshotting cost (a salesman's session cannot read cost,
so it would have written nulls).

2026-09-03 — A payment written from a phone now also writes its
`payment_orders` slices — Only the allocations decide what an invoice still
owes; `payments.amount` is never read for that. A payment collected on a
phone left every invoice fully outstanding on the web — Rejected: summing
`payments.amount` per customer instead, which cannot say which invoice was
settled and breaks the statement.

2026-09-03 — Receivables on the phone are computed by `Aging.swift`, a
direct port of the web's `lib/queries/aging.ts` — The phone summed
`order.total` for every non-draft order and subtracted every confirmed
payment for that customer, so orders that had never been billed counted as
debt, returns were ignored, and age ran from the order date rather than the
billing date — Rejected: keeping the phone's simpler sum (it disagreed with
the web on nearly every customer).

2026-09-03 — The Delivery stage is read from `app_settings.delivery_enabled`
rather than a per-device switch — It was an `@AppStorage` flag, so one
warehouse phone could show the stage and another hide it while the web
followed the database. Whether the business tracks delivery is one fact
about the business — Rejected: leaving it local and syncing it separately.

2026-09-03 — Customer change requests go to `customer_change_requests`, not
a magic string inside a news post — The phone encoded them as
`[CUSTOMER_EDIT_REQUEST]{json}` in `news_posts.body`, a table that does not
exist in this database, so a salesman's request went nowhere and the manager
saw nothing. The web already has a table with row rules for exactly this —
Rejected: creating `news_posts` and teaching the web to parse the marker.

2026-09-03 — Staff logins are created through the web app's
`/api/admin/users` with the manager's own token — The phone called
`auth.signUp`, which requires public sign-up to be on (anyone holding the
app's public key could then make an account) and which also swapped the
manager's session for the new user's — Rejected: putting the service key in
the app, which is the one thing that must never happen.

2026-09-03 — `WEB_APP_URL` is a build setting, left empty by default — Until
the web app is deployed there is nothing to point at, and the actions that
need it explain themselves rather than failing oddly. Everything else in the
app talks to Supabase directly and works without it.

2026-09-03 — `products_safe` is defined against a small `viewer_sees_cost()`
of its own rather than the existing `current_role_is()` — If that helper is
still the version that referenced a dropped column, every product read
through the view would fail, which is the fault being fixed — Rejected:
depending on the helper and requiring the earlier migration to be run first.

2026-09-03 — Approving a goods return always restores stock, from one
function — There were two approval paths on the phone and only one of them
put the stock back, so approving the same return from Reports lost it —
Rejected: fixing the second path in place and leaving two copies of the rule.

---

## 2026-09-04 — Features carried over from the Google Sheets version

Compared the app in `famlist-billing-web 3` (the Sheets version still in
use) against this rebuild, feature by feature, and closed the gaps.

2026-09-04 — Reading paperwork with AI came back, as two named buttons
rather than a floating camera button — The old app had a camera button
floating over every screen; this app's design rules that out by name
("no floating scan/camera button anywhere — explicitly removed"). The
capability is what mattered, not the button, so it sits where the work is:
on a new order beside the barcode and photo pickers, and on Products as
"Scan invoice" — Rejected: reinstating the floating button, which would
have contradicted a written design decision.

2026-09-04 — The supplier-invoice scan keeps its two-phase shape: read once,
review, then save with no second AI call — Re-reading the document to save
it would cost a second request and could come back subtly different from
what the manager approved.

2026-09-04 — A price written on a scanned or imported document overrides the
customer's remembered price — What is on the paper is what was agreed with
the customer. Lines the document gives no price for still pick up sticky
pricing and the customer's discount, exactly as a hand-added line does.

2026-09-04 — The default AI model is `gemini-2.5-flash`, not the old app's
`gemini-3.5-flash-lite` — That name is not a model this API serves, and the
old app's own notes admitted it might be rejected. `GEMINI_MODEL` still
overrides it, and a 404 now says which name failed.

2026-09-04 — Every handover in the order pipeline now writes a notification
— This app only ever raised two (an edit request and an edited payment), so
a salesman could not learn their order had been accepted, rejected, picked,
packed, approved, sent out or delivered without opening it. The old app
derived all of those. Notification writes are best-effort and never roll
back the status change that earned them.

2026-09-04 — The duplicate-order tool was carried over; the split-invoice
merge tool was not — Duplicates are still real: an order can be sent twice.
Invoices "split across rows" was an artefact of writing to a spreadsheet,
and cannot happen against a table whose rows have their own key and whose
invoice numbers carry a unique index. Porting it would have meant shipping a
repair for a fault this app cannot have.

2026-09-04 — Duplicate removal is restricted to `pending` orders server-side,
not only in the UI — The old tool deleted whatever the client sent. An order
that has moved on has stock or an invoice number behind it, so the server
refuses regardless of what is asked of it.

2026-09-04 — Imported orders arrive as `pending` and get no invoice number —
Same rule as every other order: a manager reviews it, and numbers are issued
at approval so the series stays gapless.

2026-09-04 — A target GP% sets the price, and a target subtotal scales the
line prices — Both are how a manager actually negotiates. Cost is never
touched: it is what was paid, and the invoice's discount column is derived
from the gap between the list price and what is charged. The old app spread
a subtotal change into a per-line discount column, which this schema does
not have; scaling unit price produces the same invoice.

2026-09-04 — The warehouse can correct a shelf count from the picking screen
— The moment a count is found to be wrong is while someone is standing at
the shelf. It is its own route limited to that one column, like rack
location, so the warehouse never gets near price or cost.

2026-09-04 — Team news is stored in `news_posts`, the table the phone app
already uses — Both apps now read and write the same notices. Where the
table is absent the bell still works and the Post news button hides itself.

2026-09-04 — A render error now replaces one screen instead of the whole app
— Without a boundary a single component throwing leaves a blank white page
with no way back. The nav and chrome sit outside it, and changing route
clears the error.

2026-09-04 — Not carried over: the `/api/diag` route — It reported
credential diagnostics with no authentication check at all. Its own comment
called it temporary.

2026-09-04 — Not carried over: draft trash with 30-day restore — Drafts here
are real orders in the database rather than browser-local objects, so they
are not lost by clearing a browser and there is nothing to rescue them from.

---

## 2026-09-04 — Stock floor, salesman-wise expenses, and who a sale belongs to

2026-09-04 — Stock on hand stops at zero rather than going negative, and the
rule is a database trigger as well as app code — Four articles were already
negative on the live database (HBG274 −1, HBG275 −12, BG112 −9, BG108 −5),
each the result of approving an order for more than the system believed was
on the shelf. A shelf holds nothing or something. The trigger clamps rather
than refusing, so an approval is never blocked by a count that was already
wrong, and it covers the phone and every import as well as the routes that
were changed — Rejected: a `check (stock_on_hand >= 0)` constraint, which
would have failed the approval instead of the figure; rejected clamping only
in the web app, which would have left the phone able to write negatives.

2026-09-04 — Consequence accepted: granting an edit on an order whose
deduction was clamped puts back more than came off — If an order for five is
approved against a shelf count of two, two come off; granting an edit
afterwards returns five. The information needed to do better (how much was
actually deducted) is not recorded anywhere. Clamping is the rule that was
asked for, and the warehouse can correct a count from the picking screen —
Rejected: storing a per-line "actually deducted" figure, which is a schema
change nobody asked for.

2026-09-04 — An expense carries a `salesman_id` of its own, separate from
`logged_by` — `logged_by` records who typed it in, which is always a manager
because logging is manager-gated. The Expense page's Salesman tab was
filtering on it, so it was really asking "which expenses were typed in by a
salesman" — the answer was always none, and the tab was empty. The column is
nullable on purpose: rent and utilities belong to the business, not to a
person — Rejected: inferring the salesman from the description text.

2026-09-04 — Rows entered before the column existed still fall back to
`logged_by`, but only when that person is a salesman — A manager appears in
the same picker (a manager can carry an expense too), and without the role
test every manager-logged expense would have been attributed to the manager
personally.

2026-09-04 — The salesman drill-down's figures follow its date picker, not
just the chart — Sale, orders, % to goal and amount left all read from
`entry`, which is the leaderboard's month-to-date total. Choosing Year to
date redrew the graph and left every figure beside it on this month, which is
what made the panel disagree with itself — Rejected: removing the picker.

2026-09-04 — Over a window longer than a month the goal is prorated by days,
and anything a month or shorter keeps the whole monthly goal — A monthly
target measured against a year of sales is meaningless. `max(1, days /
30.4375)` is monotone, needs no special cases, and leaves the familiar
month-to-date reading untouched. The card says "Goal (period)" when it has
been scaled — Rejected: counting calendar months touched, which makes "last
30 days" worth two months whenever it crosses a month end.

2026-09-04 — The drill-down's window is local midnight to local end-of-day —
`new Date("2026-09-04")` is UTC midnight, so every window stopped four hours
short of the end of the last day here and quietly dropped today's orders and
GP%. `fetchSaleTrend` also called `setHours` on the caller's own Date, moving
a window that other queries in the same batch were still using; it copies now.

2026-09-04 — The leaderboard names everyone who billed, not only the roster
of active salesmen — Three orders on the live database are billed by the
manager. They counted towards the company's total sale but appeared under
nobody's name, so the page did not add up. A rostered salesman still always
appears, at zero if that is the truth; anyone else appears once they have
actually billed, labelled with their role. An id with no user row behind it
is shown as "Unknown user" rather than dropped — Rejected: hiding
non-salesman sales, which is how the totals came apart in the first place.

2026-09-04 — The team's goal stays the sum of the salesmen's goals — The
leaderboard now carries people who are not on the roster; giving each of them
a target of their own would have inflated the team's target and moved a
number nobody asked to move.

2026-09-04 — An order cannot be saved without a salesman, and the id has to
be a real staff member — The edit-fields sheet offered "— none —" and the
route wrote null. An order with no salesman is a sale that belongs to nobody.
The sheet also keeps the order's current salesman in the list even when they
are off the roster, so saving cannot silently reassign the sale.

2026-09-04 — iOS: the users fetch behind order display now selects
`is_active` — It selected four columns while `SBUser` decodes `is_active` as
a plain `Bool`, so the decode threw, the whole list came back empty through
`try?`, and every order lost the name of whoever billed it — which is also
what emptied the phone's salesman leaderboard. Measured against the live
database: the narrow select returns no `is_active` key at all.

2026-09-04 — iOS: `salesman_id` is left out of an expense payload entirely
when it is not set, but written explicitly as null when it is cleared —
Omitting it keeps logging working on a database that has not had RUN-ME-8
run; writing null is the only way to take a salesman back off an expense.

---

## 2026-09-04 — Crashes, the login door, and what "overdue" means

2026-09-04 — The app that was quitting by itself is a build from 5 July, not
the current source — Every one of the four crash reports on this Mac is the
same trap: an array index out of range inside
`GoogleSheetsManager.pullArticles`, on the URL session's delegate queue, when
a sheet row came back with fewer columns than the code indexed. That file
does not exist in this project at all any more (it is in V1–V4); the app
installed in the simulator was built on 5 July, before the move to Supabase.
The current build was installed over it and runs. Nothing was changed in
`GoogleSheetsManager` — it is not part of this app.

2026-09-04 — The current source was audited for the same class of fault
rather than assumed clean — No `try!`, no `fatalError` outside the untouched
Core Data template (which nothing in the app ever loads — `PersistenceController`
has no callers), and every force-unwrap is a literal URL or calendar
arithmetic that cannot fail. The one `lines.first!` is already guarded by
`guard !lines.isEmpty`.

2026-09-04 — The login screen asks which role you are, and refuses an account
that is not it — Restored from the Sheets app's "I AM A" row, on both the web
and the phone. It is a gate, not a costume: an account registered as
Warehouse cannot sign in as Manager, so a shared device cannot quietly become
someone else's session. Admin is exempt, being a superset of every role. The
check runs after sign-in, because `users` is deliberately not readable to a
stranger — Rejected: letting the picker change what an admin sees, which is a
role-switching feature nobody asked for.

2026-09-04 — The device remembers the role last chosen — A warehouse iPad is
a warehouse iPad every morning. Stored per device (localStorage / AppStorage),
never on the account.

2026-09-04 — Remaining and Overdue are now computed from the same aging the
rest of the app uses — The Payments page had its own copy of the calculation
that ignored `orders.extended_due_date` entirely and defaulted to a 30-day
threshold where every other screen used 90. So the Payments page, the
Customers page and the statements each answered the same question
differently. It now calls `fetchOutstandingInvoices`, which already handles
confirmed payments, approved returns and extensions — Rejected: fixing the
threshold in place and leaving two copies of the rule.

2026-09-04 — Overdue starts at 90 days, and the stored settings were moved to
match — The company setting and every customer row still said 30, so
everything older than a month was being called overdue: AED 1,096,342.57 of
it. The per-customer threshold stays; only the default and the rows still
sitting on the old default were moved.

2026-09-04 — Approving an extension request now writes the order's
`extended_due_date` — It only set the request's status, so an approved
extension changed nothing anyone ages against: the invoice stayed overdue and
the salesman was still chased for it. Fixed on both the web and the phone.

2026-09-04 — The 527 blanket extended due dates are cleared by RUN-ME-9,
explicitly and by date — 526 orders carry 2026-09-03 and one carries
2026-08-19, with no approved extension request behind any of them; invoices
from November 2025 were reading as one day old, which is why the Customers
page and the Payments page disagreed so wildly. It is the user's data, so the
statement is scoped to exactly those two dates, commented, and left for them
to run rather than done quietly — Rejected: clearing every extension that has
no request row, which would also wipe an extension a manager sets by hand
from the order screen.

2026-09-04 — RUN-ME-9 re-dated 527 orders, and RUN-ME-10 puts them back —
`orders` carries a trigger that sets `updated_at = now()` on every update,
and this app reads `updated_at` as the date an order was billed. Clearing the
blanket `extended_due_date` therefore stamped today's date on all 527 orders
it touched, which made nothing overdue and moved a year of sales into this
morning. My mistake: I checked what the statement would change and not what
the table would do about it. The repair restores each order from its last
recorded status change, falling back to `created_at` — verified against the
live data to reproduce the aging figure exactly (AED 493,600.70 remaining /
AED 734,411.42 overdue). Both files now disable the table's triggers around
any bulk update — Rejected: restoring from a backup (the project is on the
free tier, which keeps none).

2026-09-04 — Worth knowing, not changed: the billing date is `updated_at` —
Every sales figure, the aging and the statements read it, so any bulk update
to `orders` moves money between months. A dedicated `billed_at` column set
once at approval would end that whole class of accident. It is a schema and
app change nobody has asked for, so it is written down here rather than done.

2026-09-04 — The Settings backup asked `expenses` for `created_at`, which
does not exist — PostgREST refuses the whole request over one unknown column,
so every backup came out with no expenses in it. It reads `updated_at`
instead. `salesman_id` was deliberately left out of that select: it only
exists once RUN-ME-8 has been run, and naming it would break the backup again
on any database that has not.

2026-09-04 — A refused goal write is shown rather than swallowed — `setGoal`
and `setTeamGoal` wrote to Supabase with `try?`. The figure updated locally
and looked saved whatever the database said, then reverted on the next
device. GoalsStore now carries a `saveError` the Reports screen raises as an
alert and the dashboard's goal editor shows in place of "Goal updated".

2026-09-04 — RUN-ME-10 did not take, so the repair was rewritten as a single
`DO` block that reports what it did — Every order still carried the two
timestamps it was meant to clear, so a statement in it errored and the
transaction rolled back; the likeliest candidate is `alter table ... disable
trigger user`. The replacement raises a named exception saying exactly what
failed, counts the rows it fixed, and folds in the VAT correction below so
that fix does not re-date the rows it touches.

2026-09-04 — Nine invoices carry a VAT amount of zero while their total is
the subtotal plus five percent — The VAT was charged and never written down,
so the tax line on those documents reads nil. Corrected to `total - subtotal`
inside the same trigger-free block. Twenty-four other orders have no VAT at
all and a total equal to the subtotal; those look deliberate (zero-rated) and
were left alone.

2026-09-04 — The manager sets a salesman's monthly goal from the Sales page —
It was only in Settings → Users, which is not where anyone looks at goals.
The field sits outside the row's button rather than inside it (a text field
inside a button cannot be typed into), and asks for the changed row back, so
a refusal is reported instead of a false "saved". On the phone the editor
already existed in the salesman sheet but was shown to everyone, including a
salesman opening their own card, where the database refused the write — it is
now manager-only.

---

## 2026-09-04 — Deleting an order

2026-09-04 — Deleting an order moves it to a Trash in Orders rather than
removing the row — A tax series should not have holes, and a mis-tap should
not cost an invoice. The order keeps its number and its history, goes to
`cancelled` so no report counts it, and can be restored to the stage it left
— Rejected: a hard delete from the list, which is one slip away from losing
an invoice nobody can reconstruct.

2026-09-04 — Deleting is one action with three consequences, all of them
carried out — Stock deducted at approval goes back on the shelf; every
payment applied to the invoice is released so the money returns to the
customer's unapplied balance rather than disappearing with the invoice; and
the order leaves every sales figure, statement and receivable because
`cancelled` is not a counted status. Doing only the first of those is how a
customer ends up owing money against an invoice that no longer exists.

2026-09-04 — Restoring re-deducts the stock but does not re-apply the
payments — The stock movement is symmetric and safe. The payments are not:
they were released when the order went to the trash and may have been put
against another invoice since, so re-claiming them would double-count. The
screen says so.

2026-09-04 — Deleting for good is a separate step, from inside the trash,
manager only — It removes the lines, the status history and the row, and the
invoice number goes with it. That is the deliberate second action for
something that should never have been an invoice at all.

2026-09-04 — A salesman may delete their own order only while it is a draft
or pending — After that it has been through somebody else's hands. A manager
may delete any order.

2026-09-04 — Every order list filters `deleted_at is null` through one
helper that falls back to no filter — On a database without RUN-ME-12 the
lists behave exactly as they did before and the Trash is empty, rather than
every order query failing over a column that is not there yet. The phone does
the same thing by holding deleted orders in a separate array rather than
filtering at the query.

---

## 2026-09-04 — Full test pass

2026-09-04 — Every query the web app makes was run against the live database
by executing the real modules, not a copy — `lib/queries/*` was loaded into
Node with a service-role client and each exported function called. 43 of 43
returned. Two more (`/api/products`, `/api/expenses`) go through server
routes and were exercised separately. This is how the products/expenses
column faults were found earlier, and it is now repeatable.

2026-09-04 — Every column named anywhere in either codebase is checked
against the live schema, read straight from PostgREST's own description of
the database — Web: nothing unknown. iOS: nothing unknown (the two dozen
apparent hits are error-message text like "permission" and payload keys the
scanner attributed to the wrong nearby table; each was read and dismissed).

2026-09-04 — The anonymous role loses all access to the data API — Tested
with nothing but the app's public key and no login: `purchases` (china and
landing cost), `products_safe`, `order_items_safe`, `payment_orders`,
`grv_returns`, `grv_items`, `order_status_log` and `zones` all returned real
rows, and an anonymous INSERT into `zones` succeeded. Nothing in either app
talks to the data API before signing in — login goes through Supabase Auth —
so `anon` needs no access at all — Rejected: fixing each table's policies and
leaving the grants, which would have left the next new table open by default.

2026-09-04 — `products_safe` and `order_items_safe` become
`security_invoker` views — A view runs as its owner unless told otherwise,
which is why they handed out rows the tables underneath them would have
refused. My own RUN-ME-7 created products_safe without it.

2026-09-04 — `purchases` becomes manager-only — It carries china_cost,
landing_cost and total_cost. Every other cost figure in the app is
manager-only; this one was readable by anyone at all.

2026-09-05 — Order counts are drawn from the same rows as order money —
"Orders this month" counted every order by `created_at`, while "Sales this
month" beside it summed counted-status orders by `updated_at`, the billing
date. In September the tile read 0 orders next to AED 7,799.07 of sales,
because six orders were billed that month and none were first drafted in it.
`countOrdersThisMonth` and `countOrdersInRange` now return the length of the
same `revenueIn` set the money comes from, so a count and its total can never
disagree again — and, being served from the cached copy, they cost nothing —
Rejected: switching only the date column, which would have left the status
filter still differing.

2026-09-05 — An order can only be created as a draft or as pending, enforced
at run time — `/api/orders/create` runs as service_role and typed `status` as
`"draft" | "pending"`, but TypeScript checks nothing at run time. A caller
posting `status: "delivered"` got an order that had skipped picking, packing
and delivery, held no invoice number, and had moved no stock — a sale
present in every total and absent from the pipeline.

2026-09-05 — Removed the Warehouse "Picking" tab from web and iOS — It was a
strictly worse duplicate of Orders. `/picking` rendered `OrdersView` with
`scope="picking"`, which showed one flat list of `waiting` + `picking` orders;
`/orders` shows the same queue split into Waiting/Picking/Packed/Delivering
stages (`showsWarehouseStages`) and includes `delivering`. The stage switcher
was built specifically to replace the flat list — see the comment at
OrdersView.tsx:295. iOS had the same pair: a Picking tab beside an Orders tab
whose sub-tabs are already Waiting/Picking/Packed/All. The `picking` order
STATUS is untouched — only the navigation entry is gone. Alternatives
rejected: keeping both (two doors to one list); deleting the route outright
(kept as a redirect to /orders so saved bottom-bar preferences and bookmarks
don't 404).

2026-09-05 — Added RLS policies giving `admin` full access to orders and
payments (RUN-ME-17) — Measured with a real session per role: admin saw 0
orders and 0 payments while manager saw 535 and 22. The original policies on
those two tables enumerate manager/salesman/warehouse and never mention
admin, so an Admin login matched no policy and read an empty table. Every
other table was already correct. Added as separate permissive policies
(which OR together) rather than editing the existing ones, so no other
role's visibility changes. Alternatives rejected: rewriting the existing
policies to include admin (larger blast radius, and the originals are not in
version control); making admin a Postgres superuser-ish bypass (defeats RLS).

2026-09-05 — iOS: report figures now date orders by `revenueDate`, not the raw
`order.date` — 8 sites across ManagerDashboardView, SalesmanDashboardView and
SalesView filtered/grouped on `order.date` while the other 23 report sites and
`Analytics.ordersThisMonth` use `order.revenueDate` (`updatedAt ?? date`, the
app-wide billing date, matching the web). Symptom: on the manager dashboard the
top "Sale" chart rendered flat/empty while the Sale widget directly below it —
same period, same orders — showed real data. Also affected the Sales page
leaderboard and its year-to-date figures. Alternatives rejected: changing
`revenueDate` itself (23 correct callers).

2026-09-05 — iOS: the dashboard "Orders" tile counts month-to-date orders, not
all orders — It read `sheetsManager.orders.count` (535, all time) while the
"Sale" tile beside it read `dashTeamMtd` (AED 8K, September). Two ranges in one
card. Now both derive from `Analytics.ordersThisMonth`, since `mtdSales` is
literally that set reduced over `saleValue`. Mirrors web commit 6efb7a6.

2026-09-05 — NOT changed, needs a business decision: the avg-sale chart sums
`order.total` (VAT-inclusive) while every headline figure uses `saleValue`
(ex-VAT subtotal). Left as-is because VAT-inclusive may be intended for an
average-order-value metric; flagged rather than silently changed.

2026-09-05 — Removed the GoogleSignIn and GoogleAPIClientForREST/Sheets pods
from the iOS app — Neither was referenced by a single line of app source.
Sign-in is Supabase Auth (LoginView.swift); Drive access is plain HTTPS in
DriveClient.swift with a service-account token minted in AppDataManager, and
imports only Foundation/Combine/UIKit. Sheets was a leftover from before the
Supabase migration. `pod install` removed AppAuth, GTMAppAuth,
GTMSessionFetcher, GoogleAPIClientForREST and GoogleSignIn. Also removed the
dead config they needed: GIDClientID, GIDServerClientID and GOOGLE_CLIENT_ID
from Info.plist (0 code references each), the com.googleusercontent.apps.*
CFBundleURLScheme (the app could no longer service that OAuth callback), and
GOOGLE_CLIENT_ID from Config.xcconfig. Workspace builds clean.
NOTE: this does NOT remove the bundled service-account key
(familist-497101-12cb1f36bc3a.json) — DriveClient still needs it, and it
remains a shipping blocker. Backups of Podfile/Info.plist/project.pbxproj are
in the session scratchpad under ios-backup/.

2026-09-05 — iOS reporting reads stored money, not line-item money — The
`Order.total` computed property is `subtotal + vat` where `subtotal` sums
`items`. 532 of 535 orders have no line items, so `total` returns 0 for
almost the whole book. Found by instrumenting the dashboard chart: the day
bucket was correct (day 4) but its value was 0. The model already had the
right accessors — `saleValue` (storedSubtotal ?? fulfilledSubtotal, ex-VAT)
and `receivableTotal` (storedTotal ?? fulfilledTotal, VAT-inclusive), both of
which fall back to live line items for an unsaved draft. Moved 8 reporting
call sites onto them: AppNavigation order rows (2), ManagerCustomersView
order row, FinancialReportsView salesman totals, OrderExcelExporter (4 — the
invoice grand total and amount-in-words were printing 0.00), plus the
dashboard avg-sale chart and its average line. NOT changed: three
FinancialReportsView sites operating on `OrderAgingDB`, whose `total` is the
database column read directly and was always correct; and `Order.total`
itself, because the New Order sheet needs it to track live line items while
editing. This also answers the earlier open question about VAT-inclusive vs
ex-VAT on the avg-sale chart: `total` was not a VAT choice, it was simply
zero. The chart now uses `saleValue`, matching mtdSales and the leaderboard.

2026-09-05 — iOS no longer ships any secret — Two credentials were in the
bundle. (1) The Drive service-account key: DriveClient signed a Google JWT on
the phone, so familist-497101-*.json shipped inside the .ipa. Added
/api/drive/{list,search,file,upload} to the web app (getAppUser already
accepts Bearer tokens, and lib/google-drive.ts already had every primitive)
and rewrote DriveClient's six network methods to call them with the user's
own Supabase token. Removed 120 lines of JWT/RS256/token-exchange code from
AppDataManager and took the .json out of the target. (2) The Gemini key was a
literal in GeminiAIClient.swift — "key is baked into the binary", per its own
comment. Now read from UserDefaults and entered in Settings -> AI scanning.
Verified against the built .app: no JSON credential, no private-key marker,
no key in the binary or Info.plist. Alternatives rejected: having the server
hand the phone a Drive access token (still a full-Drive credential on the
client, just shorter-lived).

2026-09-05 — CocoaPods removed entirely — Deleting the two unused Google pods
left zero dependencies, and the leftover CocoaPods integration then fought
the base-configuration change below ("sandbox is not in sync with the
Podfile.lock"). `pod deintegrate` plus removing Podfile/Podfile.lock/Pods.
The project now builds from Billing.xcodeproj directly.

2026-09-05 — Config.xcconfig is now actually applied — It was in the project
as a file but was never a baseConfigurationReference, so every $(...)
substitution in Info.plist resolved to empty. WEB_APP_URL has therefore never
worked, which is why iOS user-management said "set WEB_APP_URL" no matter
what was in the file. Both Debug and Release now use it. Because that makes
the file's values reach the shipped Info.plist, GEMINI_API_KEY was removed
from it first.

2026-09-05 — Extension versions aligned with the app — 28 target
configurations were at CURRENT_PROJECT_VERSION 3 / MARKETING_VERSION 3.1
while the app was at 5. "The CFBundleVersion of an app extension ('3') must
match that of its containing parent app ('5')" is an App Store upload
rejection, not a warning. All six extensions now report 5.

2026-09-05 — Web: Tailwind classes converted to logical properties — 66 sites
across 21 files (pl-/pr-/ml-/mr-/left-/right- to ps-/pe-/ms-/me-/start-/end-),
satisfying CLAUDE.md rule 7. In a left-to-right page these compile to
identical CSS, so nothing moved.

2026-09-05 — iOS accepts an email at the login, like the web — The field said
"USERNAME" and appended @fgtbilling.internal to whatever was typed, so a real
address became name@gmail.com@fgtbilling.internal and failed with a generic
"invalid credentials". Bilal's admin account is registered under a real email,
so the phone could not sign it in at all. LoginView now calls the web app's
existing /api/auth/resolve-login (the same route LoginForm uses) to turn an
email into its username first. Nil result — server address unset, or address
unknown — falls through to the normal sign-in so the failure message is
unchanged. Requires WEB_APP_URL.

2026-09-05 — Drive was never broken; the phone had nowhere to call — Verified
the service account directly: token exchange OK, it sees the PICTURES folder
(1X890e-...) and lists 13 subfolders. The four new /api/drive routes were then
tested against a real manager session: 401 with no token and with a bad token,
search returns BTT270.jpg, /api/drive/file returns a valid 46 KB JPEG, and a
salesman POSTing to /api/drive/upload gets 403. Finally confirmed on the phone
with WEB_APP_URL pointed at the dev server — the product photo renders in the
detail sheet, fetched through the proxy with the user's own Supabase token.
Most SKUs (BG112, BG113, GHB424-110) simply have no photo in Drive; BTT270 and
BTT275 do. So "photos missing" is usually "no photo for that SKU", and was
otherwise WEB_APP_URL being empty.
Added NSAllowsLocalNetworking so WEB_APP_URL can point at a local `npm run dev`
over http while testing; every non-local host still requires https.
Also fixed the xcconfig URL escape: "//" starts a comment, so the empty
interpolation has to sit BETWEEN the slashes (http:/$()/host), not before
them (http:$()//host) — the old form silently truncated the value to "http:".
PhotoBrowserView now says "Photos need the server address" instead of showing
an empty grid, which is the exact confusion this round started with.

2026-09-05 — iOS uses the web's skeleton loading, not spinners — New
SkeletonView.swift ports the web's `.skeleton` (app/globals.css): a sheen
sweeping across a rounded block, 7%→14%→7% of the secondary colour, 1.4s
ease-in-out, rows staggered 90ms so the highlight travels down a list, and a
flat tint under Reduce Motion. Provides Skeleton / SkeletonList / SkeletonCard
/ SkeletonGrid. Replaced the loading spinners in ManagerDashboardView,
WarehouseDashboardView, SalesmanOrdersTab, PaymentsView (outstanding
invoices), ManagerCustomersView (balances), PhotoBrowserView (grid + per-tile)
and DriveProofSheet. Left as spinners, deliberately: isSaving, isSearching,
cheque-scan progress, report export progress, and applying a customer edit —
those are actions in flight, not content loading, which is the distinction
rule 9 draws.

2026-09-05 — /api/product-photo never worked for the phone (or any Bearer
caller) — It answered 502 "app_settings.product_photos_drive_folder_id is not
set" while the row was plainly readable. `getSetting()` used
`supabaseServer()`, which reads the session from COOKIES only; a Bearer-token
caller therefore queried as `anon`, and RUN-ME-13 correctly revoked anon's
read on app_settings, so the folder id came back null. Added
`supabaseCaller()` (lib/supabase/server.ts): forwards the caller's own
Authorization header when present, falls back to cookies. Still never
service-role — RLS runs as that user, exactly as for the browser. This also
repairs the cheque, delivery-proof and product-photo upload routes for iOS,
which all read folder ids the same way. The browser path was unaffected
because it has a cookie.

2026-09-05 — iOS product grid shows Drive photos instead of initials — The
tiles rendered `String(desc.prefix(2))` ("TU", "GL") and never asked Drive;
only the detail sheet did. Tiles now use SKUPhotoView, with the initials kept
as the fallback when Drive has no photo for that SKU (most of the catalogue).
Added `DriveClient.photo(forSKU:)`: ONE request to /api/product-photo, which
the server answers from a warm SKU→file map, rather than the old two-trip
search-then-fetch — a grid of hundreds of tiles cannot afford per-tile Drive
searches. It carries a negative cache of SKUs with no photo so a scroll does
not re-ask for them, on top of the existing memory and disk caches.
NOT a bug, recorded so it is not chased again: the SKU text visible in a tile
("BTT-270") is printed into the source photo itself — the files are 1000x1000
squares with the code in the corner. The tile is not clipping it wrongly.

2026-09-07 — Statement of account for a whole shop group (Manager/Admin) —
145 of 356 customers carry a `group_name`, across 58 groups; "Day To Day" is
23 shops. A chain trades under several branch codes but settles ONE account,
and there was no way to statement that account: a manager pulled a statement
per branch and added them up. `buildStatement` now takes one id or several;
GET /api/customers/statement accepts `?group=<name>` alongside `?customerId=`.
Verified against the database: the group statement for "Day To Day" produces
7 rows totalling AED 5,521.43, exactly the sum of the 23 shops' delivered
invoices — and note the group's FIRST branch has zero invoices, so any
"statement the first member" shortcut would have returned an empty document.
Manager/Admin only, enforced server-side (403 for a salesman): a group
statement discloses every branch's trading to whoever holds the file. The
header says "COMBINED ACCOUNT — N SHOPS" so it cannot be mistaken for one
branch's. iOS matches, via CustomerStatementExporter.rows(codes:) and a
"Group PDF/Excel — N shops" pair in the export menu.
Deliberately NOT done: reviving the combined-shops row in the customer list.
That view was removed on purpose (§Next Updates "remove the combine shops
button"); the group statement lives in the customer sheet instead.

2026-09-07 — 17 API routes queried as `anon` for any Bearer caller — They
authenticated correctly with getAppUser() (which handles Bearer) and then did
the actual work through supabaseServer(), which reads the session from
COOKIES ONLY. From the phone every one of them saw nothing: statements,
Excel/PDF exports, invoice PDFs, order approve/delete/restore/purge/edit,
delivery finalisation, cheque upload. Found because the group statement
returned "No shops in that group" for an admin while the same query as
service-role returned 23. All 17 now use supabaseCaller(). /api/logout keeps
supabaseServer() — clearing the cookie session is its whole job.

2026-09-08 — Famlist Assistant button beside the account avatar (web + iOS) —
Added at explicit request; it is NOT in the spec, so noting it here against
rule 2 rather than pretending otherwise. Links to
https://famlist-assistant.vercel.app/ and opens in a new tab (web) or the
system browser (iOS). Deliberately not embedded: the assistant authenticates
with "Continue with Vercel", and an OAuth flow inside an iframe or WKWebView
is fragile and is the pattern Apple asks apps not to use for third-party
sign-in. Safari also keeps the session between visits, so staff sign in once.
iOS uses one shared `AssistantButton` in all three role toolbars (manager,
salesman, warehouse) so it cannot drift between them.
KNOWN LIMITATION: the assistant is behind a Vercel login. Staff without a
Vercel account reach a sign-in wall, not the assistant.

## 2026-09-12 — Shared stock between products

2026-09-12 — Two or more products can share one stock figure — Added at
explicit request ("linking product stocks: an option to add another product
under the same shared stock"); it is NOT in the spec, so noting it here
against rule 2 rather than pretending otherwise. A product gets a nullable
`stock_group_id`; every product with the same id is one physical shelf sold
under several SKUs. Migration is `scratchpad/RUN-ME-18-shared-stock.sql`.

2026-09-12 — The shared figure is mirrored by a database trigger, not
resolved in code — Stock is read-then-written in ten places (approve, grant
edit, restore, delete, purchases, goods returns, the stock route, import,
scan, the phone). Each reads its own product's `stock_on_hand` and writes it
back; an AFTER trigger copies the new figure to the rest of the group. Not
one of those writers changed, and the phone, which reads `products_safe`,
sees the right number without knowing groups exist — Rejected: a pointer
column ("my stock is product X's"), which would have meant a join in every
reader and a resolution step in every writer, on both apps.

2026-09-12 — Joining takes the existing figure; the newcomer's own count is
discarded — "Add another product under the same shared stock": the stock
that is already there is the truth, the product being added is a second
name for it. A BEFORE trigger adopts the group's figure on join so the very
first read agrees. Leaving keeps whatever the figure was at that moment —
Rejected: adding the two counts together, which would double stock that was
already counted once on the shelf.

2026-09-12 — Consequence accepted: the Reports stock snapshot values each
linked SKU at the full shared figure — `fetchStockSnapshot` sums
stock × price per product, so a shelf shared by two SKUs appears twice. Which
price a shared shelf should be valued at is a product question nobody has
answered, and the report is a specified feature (rule 1), so it is left as
it is and noted here.

2026-09-12 — Consequence accepted: two orders for two linked SKUs approved
at the same moment can lose one deduction — Each approval reads the figure,
subtracts, and writes; the last write wins and is mirrored. This is the race
that already exists today for two simultaneous orders of the same SKU, so
sharing makes nothing worse than it was.

2026-09-12 — Linking writes immediately, not on Save — It touches two rows
and the database adopts the figure at that moment; folding it into the form
would have meant Save sending a partner id and the route guessing which of
the two figures to keep. The list behind the sheet reloads on every link
change so Cancel cannot leave it stale. Salesman and warehouse sessions
receive `stock_group_id`: it is not a cost figure, and whoever may see the
stock may see whose else it is.

## 2026-09-12 — Nothing is sold from an empty shelf

2026-09-12 — At approval every line is cut to what the shelf holds, the cut
is saved as the line's picked quantity, and the approver is told — Chosen by
the owner over refusing the approval and over also blocking the item at
order time. The 4 September floor stays: stock still never goes below zero
and an approval is still never blocked. What changes is that the excess is
no longer delivered and invoiced as if it existed — the invoice says what
came off the shelf, because the cut is written to the line before the order
is approved. Linked products (RUN-ME-18) draw from one pool during the same
approval, so two SKUs on one shelf cannot together take more than the one
figure — Rejected: refusing, which the owner did not want; capping only in
the stock figure and leaving the invoice full, which is what happened before
and is what this replaces.

2026-09-12 — A product with no count kept is neither cut nor written —
`stock_on_hand` null means nobody has counted that shelf. Cutting against
it would mean treating "unknown" as "none" and zeroing every such line;
writing it would turn "unknown" into "zero" after the first sale, which is
what the old code did. Neither is a fact anyone entered, so the figure is
left alone until someone counts. The 4 September clamp trigger is
unaffected: it only touches figures below zero.

## 2026-09-12 — The phone gets the same stock rules as the web

2026-09-12 — The iOS app lives at "Downloads/Applications/Billing App/Famlist
Billing_V5/Billing" (V5, the only version with 2026 work in it; V1–V4 are
older copies and were left alone) — Identified from the workspace the owner
supplied: its Package.resolved originHash matches V5's exactly.

2026-09-12 — Approval on the phone now caps each line to the shelf, the same
rule as the web — `AppDataManager.finalizeOrder` used to call `deductStock`,
which clamped the figure at zero and billed the full quantity anyway. It now
calls `capAndDeductStock`, which cuts the line, writes the cut to
`picked_qty`, bills from the cut quantity and reports what it cut. Without
this the two apps would disagree about the same order, which is worse than
either rule on its own.

2026-09-12 — The phone caps against the database, not its local `articles`
array — The array goes stale the moment another device sells from the same
shelf, and a shared shelf is mirrored onto its siblings by a trigger the
phone never hears about. `capAndDeductStock` reads `stock_on_hand` fresh for
the SKUs on the order, then corrects the local list afterwards — Rejected:
capping against the cached figure, which would cut lines against a number
that may be hours old.

2026-09-12 — If the shelf cannot be read at all, the phone falls back to the
old deduction rather than approving an order that moves no stock — A network
failure between reading and writing should not silently make an approval
stock-neutral. Nothing is capped in that case, and the failure is logged.

2026-09-12 — Linking is written straight to `products.stock_group_id` from
the phone, not through the web's /api/products/link-stock route — The phone
already writes `products` directly (stock, rack, article edits), and the two
database triggers do the real work: joining adopts the group's figure and any
later change is mirrored. Putting the route in the middle would have added a
second authorisation path for no behaviour the triggers do not already
enforce — Rejected: a WebAPIClient call, which would have made the phone
depend on the web app being deployed to link two products.

2026-09-12 — Consequence accepted: the phone shows "Stock shared with …"
only where it already shows the stock figure — On the web every role sees
both; on iOS `ArticleDetailSheet` hides the Stock card behind `showsCost`,
which is manager-only. Widening that is a change to who sees what, which
rule 1 says to ask about first. Flagged to the owner rather than changed.

2026-09-12 — Shared stock reached the phone as well: link and unlink in the
product editor, "Stock shared with …" in the detail sheet, and pooling at
approval — Both apps now read and write the same `stock_group_id`, so a shelf
linked on one is linked on the other.

2026-09-12 — Restoring stock on the phone also reads the database now, not
the cached list — `adjustStock` computed `local figure + quantity` and wrote
it. That read-then-write from a possibly stale cache was survivable while
each SKU stood alone; with shared shelves the database copies whatever is
written onto every other SKU in the group, so one stale entry would have set
the whole shelf wrong. Both stock paths now go through one `stockPools`
helper that reads the figures fresh and pools linked SKUs — Rejected: leaving
the restore path alone, which would have made shared stock a way to spread a
wrong number.

2026-09-12 — Only a failed database read falls back to the local list, and it
says so in the log — `deductFromLocalList` is the pre-2026-09-12 behaviour
kept for that one case: it is a guess built on a cache, so it is named for
what it is rather than sitting on the normal path.

## 2026-09-12 — Closing the gap between the web app and the phone

2026-09-12 — The two apps already agreed on which invoice document to issue;
what was wrong was two call sites that never asked — The rule is "a manager
may print a tax invoice at any stage, everyone else only once the order is
delivered". The web has it in /api/invoice-pdf and the phone had it spelled
out in AppNavigation, but the warehouse and salesman exports passed no
document kind at all and took the `.performa` default. A salesman sharing a
delivered order's invoice from the phone therefore sent a performa where the
web sent a tax invoice. There is now one `OrderInvoiceDocumentKind.forExport`
that every call site uses. `.performa` stays the default for a caller that
does not ask, because issuing a performa when a tax invoice was due is an
inconvenience, while issuing a tax invoice that was not due is a claim about
a sale that has not happened — Rejected: changing the default to `.tax`,
which would make every future forgotten call site the dangerous way round.

2026-09-12 — The database is now the truth for goals, bonuses and incentive
notes, on both apps — `GoalsStore` treated UserDefaults as the source: a
target typed before the staff list had synced was kept locally and never
written, with nothing said, and the bonus and the offer note were never
written to the database at all. Both apps now read and write
`users.monthly_target`, `users.monthly_bonus` and `users.incentive_note`, a
sync overwrites the local copy, and a change that cannot be written says so
instead of looking saved — Rejected: keeping the local copy authoritative
with a longer sync, which is what let two devices disagree indefinitely.

2026-09-12 — `users.monthly_bonus` and `users.incentive_note` are guarded
against self-award — RUN-ME-20 extends `guard_user_privileged_columns()` from
RUN-ME-3 to cover the two new columns. Without it the existing "a user may
edit their own row" permission would have let a salesman set their own bonus.
ORDERING HAZARD: run RUN-ME-20 after RUN-ME-3, and re-running RUN-ME-3 later
drops the two new names from the guard — the file says so at the top.

2026-09-12 — The phone holds picking work that cannot reach the server
instead of losing it — `updateOrder` wrote to the local cache and then to the
database; a failure was reported to nobody and the order looked picked on
that handset and untouched everywhere else. `OfflineOrderQueue` keeps the
write, replays it when the connection returns, and the picking screen says
how many are waiting. Only a failure that reads as a lost connection is
queued: a rejection by the database is reported, because retrying it would
not help — Rejected: the web's per-line queue shape, which does not fit an
app that writes whole orders.

2026-09-12 — The phone's AI scanning now goes through the web app first and
falls back to a key on the handset — The per-device Google AI key is the same
class of problem as the Drive key that was moved to the server on 2026-09-08:
a secret handed to every phone. Scans now post to /api/scan-order and
/api/scan-articles with the user's own Supabase token, so the key can live
only on the server. The on-device key still works and nothing anybody set up
stopped working (rule 1), so it is the fallback for a phone with no
WEB_APP_URL or a server with no key.

2026-09-12 — Consequence accepted: the phone's scan-order results now come
back matched against the catalogue — The web route matches each scanned line
to a product before replying, which the phone's own scan does not do. That is
a better answer, not a worse one, but it means the same photo can produce
slightly different line text depending on which path served it.

2026-09-12 — Delivery proof accepts more than one photo on the phone —
It wrote `INV<number>_<date>.jpg` every time, so a second photo of the same
delivery overwrote the first. Numbering now matches the web's
`deliveryProofName` exactly: the first keeps the plain name, later ones get
`_2`, `_3`, so the Invoices screen's prefix search still finds all of them.

2026-09-12 — `ArticleDetailSheet.swift` is dead code and was left in place —
It has no callers; the live product sheet is `ProductDetailSheet` in
ManagerProductsView. This matters because a parity audit read it as the real
one and concluded the phone hid stock from salesmen, which it does not.
Removing it is a deletion nobody asked for (rule 1), so it stays, noted.

2026-09-12 — `route_visits` carries no `org_id`, against rule 3 — Nothing in
this database has one: there is no `org_id` column, no `orgs` table and no
tenant helper in any migration. A column referencing nothing would imply an
isolation that is not enforced anywhere. The table follows this database's
actual pattern instead — RLS enabled and FORCEd, scoped with
`current_app_user_id()` and `current_role_is('manager')`. Flagged rather than
invented.

2026-09-12 — Adding an article the order already has adds to that line on
both apps — The phone merged; the new web route opened a second line. Two
lines for one article are not wrong, but they read as a mistake on an invoice
and the same action should not produce differently shaped orders. The price
already on the line is kept: it may have been negotiated, and another box is
not a reason to reprice what was agreed.

2026-09-12 — Reopening a packed order stamps it as edited on both apps —
The phone's `reopenForRepack` stamped it and the new web route did not.
Pulling a packed order back apart is exactly what the next person to look at
it should see.

2026-09-12 — The web's data grid leaves Orders and Users read-only — The
phone's grid edits only Customers and Articles too. Editing orders from a
spreadsheet would need a generic "update any table" route, which is a
security hole, and users belong to the Users tab which already has its own
rules.

2026-09-12 — The backup download reads through the caller's own session, not
the service key — So the file contains what that person is allowed to see and
nothing more. `scripts/backup.mjs`, the nightly service-role backup to Drive,
is a different thing and was not touched.

2026-09-12 — SUPERSEDED the same day by "The remaining four differences are
now aligned", below. Left in place because it records what was true for part
of the day and why, which is the point of this log.
2026-09-12 — Not aligned, deliberately: where things live on screen — The
phone keeps a separate arrangeable reports board, one merged notifications
screen and a Delivery section of its own; the web folds those into its
dashboard, splits notifications into a bell and an inbox, and treats delivery
as a stage of Orders. Each is a working screen people already use, and
changing it is a change to an existing specified feature (rule 1). The
underlying data and rules now match; the layouts do not, and that is the
remaining difference.

## 2026-09-12 — The tenancy check, and what rule 3 actually means here

2026-09-12 — `npm run test:tenancy` now exists, and it tests the half of rule 3
that is real — The script every task was supposed to be verified against had
never been written, so three rounds of work were reported as "could not run
it". It now exists as scripts/test-tenancy.mjs. What it proves is the thing
that actually went wrong once: on 4 September the public key alone returned
real rows from eight tables and could insert into `zones`. The check discovers
every table and proves each refuses an anonymous read and an anonymous write —
Rejected: introspecting pg_class for relrowsecurity, which needs a helper
function and tests the mechanism rather than the outcome. What matters is
whether data comes out, not which switch is set.

2026-09-12 — The write probe sends a wrongly-typed value, so nothing can ever
be written by the check itself — Postgres tests the privilege before it judges
the value, so "permission denied" means the door is shut and a complaint about
the value means it was not. An empty-object probe would have created real rows
in any table that wrongly allowed it, which is how you turn a security test
into a data incident.

2026-09-12 — A probe that cannot reach the permission check reports "not
probed", never "pass" — The first version sent `{"id": ...}` and counted four
tables as failures because they have no `id` column, so PostgREST refused the
request before Postgres ever saw it. A security check that cries wolf is worse
than none. It now picks a column from the schema whose type cannot hold the
probe value, and says so plainly when no such column exists.

2026-09-12 — Rule 3's `org_id` half is reported, not enforced, until this
database has a tenant key — No table has `org_id`; there is no orgs table and
no tenant helper anywhere. A check that failed on all 25 tables every run would
be switched off within a week. Instead the script names the tenancy model it
finds, and the moment `org_id` appears on any table the rule becomes live
automatically: from then on a table without it is a failure.

2026-09-12 — Found by the new check: `order_items_safe` granted INSERT to
anon, `products_safe` did not — Nothing can be written through it today (it is
a view with no INSTEAD OF trigger), which is why it has been harmless. It goes
anyway: both views deliberately run as their owner rather than as the reader
(RUN-ME-15), so a write through one would carry the owner's rights. Fixed by
scratchpad/RUN-ME-22-safe-views-are-read-only.sql. Neither app writes through
either view — every reference on both sides is a SELECT.

2026-09-12 — The remaining four differences are now aligned — Reports: the web
gains the phone's arrangeable board above its financial tables, which are
untouched. Notifications: the web's Inbox becomes the one page showing both
what needs attention and the feed, and the bell stays as the quick glance;
the phone gains the delete-a-news-post the web already had. Delivery: the
phone now builds and files the tax invoice at delivery, as the web's
finalize-delivery route does, and the web gains a Delivery destination for the
warehouse. Photos: the web gains a Drive folder browser beside its catalogue
gallery. In every case the existing screen was added to, never replaced.

2026-09-12 — Drive search is now scoped to the photo library, and was not
before — `searchDrive` queried everything the service account could see. Both
callers are photo browsers, but the account also holds the private uploads
folder: cheque photos, delivery proof, invoice PDFs. A salesman typing a
customer's name into the product photo search would have been handed pictures
of that customer's cheques. Nobody had to do anything wrong for that; it was
one unscoped query. Drive cannot search a subtree, so the scope is named
explicitly — the library root plus the category folders inside it — and cached
for a minute because a search box asks on every keystroke. Found while adding
the web's Drive browser; it has been reachable from the phone all along.

2026-09-12 — The Delivery nav entry is hidden when delivery is switched off —
`app_settings.delivery_enabled` already decides whether the warehouse has a
delivery stage at all. Without the check, a business that hands goods over at
approval would get a navigation item that lands on an empty stage. Mirrors how
the Planning item is spliced in.

2026-09-12 — Reading team news in the Inbox does not clear the bell's news
badge — The bell keeps its own "last seen" marker in the browser and does not
re-read it while mounted, so writing it from the Inbox would not update the
badge anyway. Left as it is rather than half-wired; the badge clears when the
bell is opened, as it always has.

2026-09-12 — The orders page now reads a `?stage=` parameter, but does not
write one — It is what the Delivery nav entry lands on. Making every stage pill
push a URL is a change to how that screen has always worked and nobody asked
for it.

## 2026-09-12 — This is one business, and the rules now say so

2026-09-12 — The owner settled it: this application is not being sold to
anyone else — Asked directly whether multi-tenancy was a real plan, the answer
was no. That closes a question the working rules had left open since they were
written, and it is a decision about the business, not about the code, so it
does not expire the next time somebody reads rule 3 and wonders.

2026-09-12 — CLAUDE.md rule 3 now describes what is actually enforced —
It asked for `NOT NULL org_id` on every business table. No table has ever had
one, so for the life of this project the rule has been half-followed and
half-ignored, and every session that read it either invented a column nothing
else used or quietly skipped the rule — and, having skipped it once, skipped
the RLS half with it. It now reads: RLS enabled and FORCEd on every table, and
nothing reachable without signing in, proved by `npm run test:tenancy`. The
org_id sentence is replaced by an instruction not to add one — Rejected:
leaving the rule as an aspiration, which is how it came to be ignored.

2026-09-12 — The check now treats an `org_id` appearing as a failure, not as
a mode switch — Its earlier behaviour was to start enforcing the column the
moment one appeared anywhere. With the decision settled the other way, a
column turning up means either the decision changed or something was added by
mistake. Both are worth stopping for, so it says so instead of silently
changing what it enforces.

2026-09-12 — The opening line of CLAUDE.md called this a multi-tenant SaaS
application, and the document list named four specifications that were never
written — Both were read first by every session and both were false. The
framing now says what this is: one business, two clients, one database. The
list now names the four documents that exist and says plainly that the other
four do not, so nobody stops work over a spec section they cannot cite.

2026-09-12 — Rules that are still contradicted by the codebase, left alone
and flagged rather than quietly rewritten — Rule 6 says money is integer minor
units; every price, target and total in both apps is a decimal. Rule 7 says
user-facing strings live in an i18n catalog; there is no catalog and every
string is inline. Rule 8 says long-running work goes on a queue; the bulk
invoice export and the AI scans run in request handlers. The architecture
section says images go to Cloudflare R2; they go to Google Drive. Each is a
real engineering decision with consequences, and unlike tenancy none has been
put to the owner — so they stay as written until it is.

## 2026-09-12 — Fixing the four rules the code contradicted

2026-09-12 — RUN-ME-22 was wrong and RUN-ME-24 replaces it — It revoked the
write privileges on the two safe views from `anon` and `authenticated`. It ran
cleanly and did exactly what it said, and the privilege was still there: it is
held by PUBLIC, the pseudo-role every role inherits from, so revoking from a
role that is only inheriting it takes nothing away. RUN-ME-24 revokes from
PUBLIC, grants SELECT back to `authenticated` alone, and narrows the schema's
default privileges so the next view is not born writable. My mistake, not a
mistake in how it was run — and the reason the tenancy check kept failing
after it had been applied.

2026-09-12 — Rule 6 was already true of the database and false of the app —
Every money column is Postgres `numeric`, which is exact decimal: there has
never been a float in the schema. But every figure the apps COMPUTE is a
float, and they were written to those exact columns unrounded, so an order
could be billed and VAT-returned as 1234.5600000000002. Both apps now count in
fils and round once: `lib/money.ts` and `Money.swift` do the same arithmetic in
the same order, because they bill the same orders. `npm run test:money` proves
no figure with more than two decimals can reach the database and that the
lines plus the VAT equal the total — Rejected: converting the money columns to
integer minor units, which is what the rule literally asks for. It would
rewrite every historical invoice and VAT record on a live system to buy
exactness the `numeric` columns already have. The rule exists to keep float
error out of money; that is now achieved. Raised with the owner rather than
done silently.

2026-09-12 — VAT is rounded once and the total is the sum of rounded figures —
Not subtotal × 1.05, which can disagree with subtotal + VAT by a fil. A
customer adding the invoice up by hand gets the number printed on it.

2026-09-12 — The product photo endpoint was handing every grid tile the
full-resolution file — `/api/product-photo` fetched the original bytes from
Drive for every caller, including the 144px tiles in the product list and the
order sheet. It now takes a `w=` and serves Drive's own rendered thumbnail at
that width, falling back to the original only when Drive has not made one yet.
Only the zoomed detail sheet asks for the original. The phone already did this
correctly, so this was a web-only fault.

2026-09-12 — The architecture line named Cloudflare R2, which has never been
used — Storage is Google Drive and has been throughout. Moving would need a
new account, which the cost-discipline rule says to ask about first, and would
mean relocating every existing photo, cheque, delivery proof and invoice PDF.
The line now describes Drive and says to ask before proposing R2. The
substantive half of that rule — never serve a full-resolution image to a grid
— is now real and enforced in code. Serving WebP/AVIF is still not done: it
needs an image library, which is a dependency, which the same rule says to ask
about.

2026-09-12 — The iPhone app's test suite has never been runnable, and still
is not — `xcodebuild test` on the Billing scheme fails before it compiles a
single test: the "Famlist Billing Watch AppTests" target's TEST_HOST points at
`Billing.app`, the iOS app, copied from the iOS test target when the Watch
target was added from an Xcode template. Pointing it at the Watch app instead
produces a dependency cycle, because the iOS app embeds the Watch app; marking
it skipped in the scheme does not help, because the scheme still builds it.
The target contains nothing but the two empty template methods.
   The proper fix is to take that target out of the Billing scheme's test
action in Xcode, or delete it — both are project-structure changes on a target
somebody deliberately created, so they are the owner's call (rule 1). The
project file and the scheme were restored exactly as found.
   Consequence worth knowing: there are eight test files in BillingTests that
have never run. One of them, StatementExportTests, had been calling a
`CustomerStatementExporter.rows` signature that stopped existing some time ago
— it now calls the real one, which is how that rot was found.

2026-09-12 — `Money.swift` is verified against the web app's figures rather
than through the broken test target — `BillingTests/MoneyTests.swift` was
written and stays for when the suite runs, but it cannot run today. The
arithmetic was instead checked by compiling the real Money.swift on its own
and running the same cases as `npm run test:money`: every figure matches the
web's to the fil, including the 37-line and 120-line orders. The two apps bill
the same orders and now reach the same numbers.

2026-09-12 — Every user-facing string on the web is now in a catalogue —
`lib/i18n/en.ts` holds 1,551 keys and `t()` is called in 2,147 places across
118 files. There is one language, so there is no provider, no locale
switching and no async loading: `t()` is a plain typed lookup usable from a
server or a client component, and a key that is not in the catalogue is a
TypeScript error rather than an empty string. Building the machinery for
languages nobody has asked for would be adding a feature (rule 2); making the
strings addressable is what rule 7 actually asks for.

2026-09-12 — RESOLVED the same day, see "The twenty duplicate sentences are
gone" below.
2026-09-12 — Known debt: 20 sentences have two keys each — Each area was
migrated separately and told not to add to `common.*`, so the goal/bonus
editor, which exists twice in the source, produced pairs like
`sales.goalInvalid` and `settings.goalOutOfRange` with identical English.
They render identically; the cost is that changing one and forgetting the
other is possible. Collapsing them means re-touching twelve already-verified
files for no user-visible gain, so it is recorded here rather than done at
the end of a long session. (A further 113 duplicates are single words used as
column headings in different screens — those are fine as they are, because
the same English word is not always the same label.)

2026-09-12 — Postgres is the queue, and the worker is a request — Rule 8 says
long-running work goes on a queue, and the app had four things running inside
request handlers: the bulk invoice export (up to 200 PDFs), the spreadsheet
import, and the two AI scans. There is no worker host and cost discipline
rules out renting one, so `jobs` is a table and `/api/jobs/run` is the worker.
Claiming is a conditional `update ... where status = 'queued' returning`, so
two tabs racing both send the same statement and exactly one gets the row.

2026-09-12 — The bulk export is sliced and zipped in the browser, not polled —
Its result is a file, not a row, and there is nowhere to park 200 PDFs for a
poller to collect later (images go to Drive; there is no object store). The
worker builds twenty invoices per call and returns them; the browser
accumulates and zips. That removes the timeout and makes the progress bar
honest — it counts invoices actually built, rather than guessing.

2026-09-12 — All four jobs keep their original inline route as a fallback —
Until RUN-ME-23 is run there is no `jobs` table, so enqueueing answers "not
queued" and the caller falls through to the old endpoint. Both paths call the
same functions in `lib/job-runners.ts`, so they cannot drift.

## 2026-09-12 — The phone's test suite runs, and what it found

2026-09-12 — The Watch test target was removed from the Billing scheme's test
action, and nothing was deleted — It is Xcode template scaffolding containing
two empty methods, and it was listed as a testable of the iPhone app's scheme.
That is what stopped the suite building: its host app is the watch app, and
wiring it up produces a dependency cycle because the phone app embeds the
watch app. Taking it off the phone app's scheme is the smallest change that
works. The target still exists and can be run from the watch app's own scheme
if anyone ever writes a watch test — Rejected: deleting the target, which
removes something somebody created; rejected marking it skipped, which does
not stop it being built.

2026-09-12 — 37 tests now run and pass. Seven were failing the moment the
suite could build, every one of them because the test was stale rather than
the code being wrong:
   * Three AnalyticsTests expected sales figures to include VAT. Both apps
     report sales EXCLUDING it on purpose — `monthTotal` says "pre-VAT" and the
     web's `saleValue` reads `subtotal`. VAT is collected for the government
     and is not revenue. The expectations dated from before that decision.
   * Two ExcelExportTests expected "AED" and "EA" in the spreadsheet. It
     writes bare numbers so a spreadsheet can sum them, and spells the unit
     "Each". The PDF is where the currency appears.
   * StatementExportTests still built its fixture with status "Completed",
     which stopped being the delivered status, and still expected to be handed
     a payments figure that now comes from the database. Rewritten to assert
     what is true with no database behind it.
   * DraftStoreTests passed alone and failed in the full run: the suites run
     in parallel and share UserDefaults, so a fixed half-second wait for a
     background flush was a coin toss. It now waits for the value instead of
     guessing how long it takes.

2026-09-12 — Found by the newly-running suite: the Excel export hard-wired 5%
VAT — Same fault as the PDF exporter earlier today. A customer in a zone with
a different rate got a spreadsheet that disagreed with the invoice they were
billed. It now uses the order's rate and counts in fils like everything else.

2026-09-12 — The twenty duplicate sentences are gone; the hundred and
thirteen duplicate words stay — Eighteen of the twenty were the goal, bonus
and incentive editor, which exists as a 1:1 copy on the Sales page and in
Settings. The `sales.*` keys were kept and the `settings.*` twins deleted:
the subject is sales goals, and four of the Settings names actively lied
(`settings.monthlyGoalTitle` held hint text, not a title). They did NOT move
to `common.*` — they are one feature's strings on two screens, not app-wide
vocabulary. The other two were an import message that belongs to the shared
import button, and a scanning error that belongs to neither area and did go
to `common.*`.
   The 113 single words — "Customer", "Date", "Amount", "SKU" — stay as they
are. The same English word is not always the same label, and merging them
removes the ability to reword one screen without rewording another.
   Left knowingly inconsistent: "The scan failed" still has two keys while
its sibling "Couldn't reach the server while scanning." was collapsed, in the
same two components. It is a three-word fragment rather than a sentence, so
it falls on the "leave it" side of the rule — noted because the result looks
odd side by side.

2026-09-12 — Eight catalogue keys are referenced by nothing, and were left —
Seven are `common.*` (`retry`, `next`, `yes`, `no`, `add`, `export`,
`refresh`) and read as a deliberately seeded shared vocabulary; one,
`products.noProductRowsFound`, is genuine dead weight left behind when that
string moved into the job runner. Deleting untouched keys is not part of a
de-duplication job (rule 2), so they stay until somebody decides.

2026-09-12 — The iPhone app's strings are in a catalogue too, in the shape
Swift wants — `Billing/Strings.swift` defines `enum S` with a `common` area,
and each screen area adds its own `extension S` in its own file
(`Strings+Orders.swift` and so on) so several areas can be migrated without
fighting over one file. Nested enums of `static let` rather than a dictionary
lookup: a name that does not exist is a build error, and there is no runtime
lookup to return an empty label to somebody. Strings that vary are `static
func`, so a call site cannot forget an argument. Area names match the web's
key prefixes, so a string that exists in both apps is findable in both.

2026-09-12 — Three kinds of Swift string were deliberately left inline, and
getting this wrong would have been silent — SF Symbol names, `UserDefaults`
and `@AppStorage` keys, and any enum `rawValue` that is persisted or compared.
Several product and report enums use their display label AS their `rawValue`
and write it to storage: those kept the `rawValue` byte for byte and gained a
separate `label` property, so a person's saved column layout survives. Status
values, Supabase column names, CSV headers, Drive file-name patterns and date
formats stayed put for the same reason: they are read by a machine, not a
person.

2026-09-12 — Some visible text is stored data first, and was deliberately
left inline — Three of these turned up, and each would have broken something
quietly if it had been moved behind a symbol somebody could later reword:
   * `"Packed by <username>"` is written into `orders.manager_note` and then
     matched with `localizedCaseInsensitiveContains` against notes already in
     the database, so that re-packing does not stack the tag twice. Reword it
     and it stops matching every row written before the change.
   * The tab-bar section titles are joined and saved under
     `tabs.order.<role>`, and read back by comparing the saved title against
     the enum's. Change one and a person's arranged tab bar silently empties.
     A comment now records what a future change would have to migrate.
   * Payment notes ("GRV credit applied: …", "Discount applied by …") and the
     body of the manager's change-request notification are written to the
     database and are deliberately word-for-word the same as the web app's.
   Moving any of them is a decision about existing rows, not a refactor.

2026-09-12 — Enums whose display label is also their stored value keep the
value and gain a label — Products columns and sort keys, report tabs, expense
categories, payment and cheque statuses, the login role, and the sales widget
identities all did this. In every case the `rawValue` is byte-for-byte what it
was, because it is what sits in `UserDefaults` or in a database column, and a
separate `label` property is what the screen now reads. Nobody's saved column
layout, sort order or tab arrangement moves.

2026-09-12 — Known debt: a second pass should pull shared words into
`S.common` — Each area was migrated in isolation and told not to edit the
shared file, so a handful of words exist twice: "AED", "Grid"/"List",
"Manage Team", "Change Password", "Customers"/"Payments"/"Invoices"/"Orders",
"Ready", "Info", "Saved", "Error", and a few formatting helpers such as
"\(n)d" and "Page x of y". They render identically today. Collapsing them is
the same contained follow-up the web catalogue had, and is best done in one
pass now that every area has landed.

2026-09-12 — Three different characters mean "no value" and that was left
alone — `S.common.notSet` is an em dash, the Sales page has always drawn a
plain hyphen, and the aging table an en dash. They are genuinely different
glyphs in the original, so they stayed different rather than being quietly
normalised into one. Worth reconciling deliberately if anybody cares.

## 2026-09-13 — Shared stock: many SKUs on one shelf, and moving one is asked about

2026-09-13 — Confirmed and documented: a shelf carries any number of SKUs,
not two — The owner's reason is online selling, where one physical stock is
listed under several model, size or colour SKUs and the specific SKU has to
appear on the invoice. The design already supported it: the link is a shared
group id rather than a pair, the picker excludes the product itself and
everyone already on the shelf so adding can be repeated, and approval pools
by group so three linked SKUs on one order cannot between them take more
than the one figure. `scratchpad/CHECK-shared-stock-with-many-skus.sql`
proves it against the live database inside a transaction that rolls back, so
it can be run without touching real stock.

2026-09-13 — Adding a product that already shares another shelf now names
what it is leaving and asks — A SKU belongs to one shelf, so adding it to a
second takes it off the first, and whoever it was sharing with is left
holding the figure they had at that moment. Nobody would guess that from a
button called "add". Both apps now stop, name the SKUs being left behind,
and do nothing until the person says to move it — Rejected: refusing the
move outright, which removes something that was possible before (rule 1);
rejected merging the two shelves, which would link products nobody asked to
link.

2026-09-13 — The rule lives in the web route AND in AppDataManager, on
purpose — The phone writes to `products` directly rather than through the web
app, so a guard in the route alone would not cover it. Both implementations
ask the same question and skip it in the same case: a group of one is not a
shelf anybody shares, so leaving it costs nothing and is not worth a dialog.

2026-09-13 — Not built, worth knowing: the product LIST does not show which
rows share a shelf — Only the detail sheet and the editor do. With an online
catalogue where many SKUs are variants of a few physical products, a marker
in the list might matter. Nobody asked for it, so it is recorded rather than
added (rule 2).

## 2026-09-15 — The Watch app became a real companion, not just a notification viewer

2026-09-15 — Scope, agreed with the owner before building: warehouse users
can tick order lines picked directly on the watch; manager and salesman
users get their phone's primary tabs as swipeable pages instead of a tab
bar. This was not in a spec — there was none for the watch beyond the
existing notification viewer — so it was confirmed with the owner
(Watch picking scope / Tab paging scope / Sequencing) before any code was
written, per rule 2.

2026-09-15 — The watch has no Supabase session of its own and still
doesn't — `WKRunsIndependentlyOfCompanionApp` was already `NO` and stays
that way. `AppDataManager` (phone) pushes a role-scoped snapshot of
orders/customers/articles to the watch over `WCSession.updateApplicationContext`
(`WatchOrderSync.swift`), and the watch sends pick toggles back over
`sendMessage`/`transferUserInfo` (`WatchAppData.swift`), applied by
`AppDataManager.togglePickFromWatch` — the same rule
`WarehouseOrderPickView.togglePick` uses in-app, with the picker of record
being whoever is signed in on the paired phone. Rejected: giving the watch
target its own Supabase client/entitlements and querying directly — nothing
technically blocks it, but it would mean a second place holding
auth/session state for one login, and the cost-discipline rule says ask
before adding new account/API-key surface. Not asked, not built.

2026-09-15 — The existing Watch notification viewer (`ContentView.swift`,
`WatchNotificationsStore`) was left untouched and kept as the last page —
rule 1 says never remove a shipped feature without asking, and it wasn't
asked. `Famlist_BillingApp.swift` now opens on the new `RootPagedView`
instead of `ContentView` directly, but `ContentView` itself is unmodified
and still reachable by swiping to the last page.

2026-09-15 — Watch pages mirror each role's phone `phonePrimary` order
exactly (`AppNavigation.swift`): Manager = Dashboard/Orders/Customers/
Products, Salesman = Dashboard/Orders/Sales/Products, Warehouse =
Dashboard/Orders/Products/Customers — so nobody has to relearn an order
that already exists on the phone.

2026-09-15 — The watch payload never carries `cost`, `lineCost` or
`grossProfit` — the DTOs (`WatchArticlePayload`, `WatchOrderItemPayload`)
simply don't have the fields, so there is no per-role gate to get wrong or
forget (docs/why-cost-prices-are-hidden.md).

2026-09-15 — The application-context push is capped at 25 orders / 50
customers / 50 articles (`WatchOrderSync.swift`), newest/alphabetical
first — the watch is for glancing at active work, not the full history,
and a large `updateApplicationContext` dictionary is slow to deliver over
Bluetooth. Silent truncation is noted here because nothing in the UI says
"and N more" — Rejected: paging the sync itself, which is not worth the
complexity for a first cut of a feature nobody had asked for before today.

2026-09-15 — A pick made on the watch is optimistic locally
(`WatchAppDataStore.localPickOverrides`) until the next snapshot from the
phone confirms it, mirroring how the phone's own picking screen updates the
UI before the network write lands — Rejected: waiting for a reply before
showing the tick, which would make the watch feel slower than the phone for
the exact same action.

2026-09-15 — Signing out on the phone now also clears the watch's copy
(`AppDataManager.onSignedOut` calls `WatchOrderSync.shared.clear()`) — a
shared warehouse handset already lets the next person choose a different
role (2026-09-04, "the device remembers the role last chosen"), and a
former user's orders/customers must not linger on the watch after that
switch.

## 2026-09-18 — Discounts and returns at collection become real, and six owner requests

Everything in this section was asked for by the owner in one message; that
message is the specification (there is no other). Both apps were changed.

### Collecting a payment

2026-09-18 — A discount given while collecting now comes off the selected
invoices together with the cash, oldest first — Both apps wrote "Discount
applied by …" into `payments.notes` and nothing else. Only the per-invoice
slices in `payment_orders` decide what an invoice owes, so the discount
settled nothing and the customer went on owing it. The phone was worse: it
wrote the NET amount as the payment and allocated only that, so a 10%
discount on 1,000 left the customer owing 100 more than before they paid.
`payments.discount_amount` (RUN-ME-25) now holds the figure, and the slices
carry cash + discount — Rejected: a separate `discount_amount` on each
`payment_orders` row. It would be the more exact ledger, but every reader of
a balance on both apps (aging, statements, the Orders "received" column,
planning) would have had to learn a second column at once, and an un-updated
phone would have gone on ignoring discounts. One figure per slice means every
existing reader is right without changing.

2026-09-18 — Consequence accepted: "Received" on a statement and on the
Orders list now includes discounts — It is what settled the invoice, which is
what that column has always meant. `payments.amount` is still cash only, so
"Collected" on the Payments page and in reports is still money in hand.

2026-09-18 — The allocation rule lives in one tested function per app —
`allocateFifo` / `settledNow` in lib/money.ts, `Payments.allocate` /
`settledNow` in Payments.swift, counted in fils, with the same cases in
`npm run test:money` and BillingTests/PaymentAllocationTests. Ticked invoices
oldest first, then the customer's other invoices oldest first, never more
than an invoice owes, anything left over stays unallocated.

2026-09-18 — A goods return typed while collecting is raised as a pending GRV
request for that amount, under that customer — It was a sentence in the
payment's notes. It created no `grv_returns` row, so no manager ever saw it,
while the collection screen showed the balance as settled. It is now a
request (`grv_returns.amount`, `payment_id`, `notes`; no lines yet) that
appears in Payments → Returns (GRV) and in the manager's Inbox, already
carrying the customer. The manager opens it, enters the products that came
back, and approves; only then does it come off the balance — Rejected:
crediting it immediately, which is what the old screen pretended to do.

2026-09-18 — What an approved return credits: its `amount` when it has one,
otherwise the value of its lines — The amount is what the collector and the
customer agreed at the door, VAT included, because it was set against invoice
totals. The lines are there so the GRV product report is right, and the
manager can change the amount while entering them. Returns logged before
today have no amount and are valued from their lines exactly as before. On a
statement an amount is split into ex-VAT and VAT rather than grossed up, so
the statement comes down by exactly what aging took off.

2026-09-18 — NOT changed, worth knowing: a return with no amount is credited
ex-VAT by aging and VAT-inclusive by the statement — `fetchApprovedGrvCredit`
sums qty × unit_value; the statement adds VAT on top of the same figure. They
have always disagreed by the VAT on old-style returns. Returns raised with an
amount do not have the problem. Which of the two is right is a question about
how credit notes are issued, so it is recorded rather than decided here.

2026-09-18 — A return cannot be approved until at least one product is on it
— The owner's reason for the manager's step is "so that we can get the GRV
product report correct". A request approved with no products would credit
money against goods nobody can name.

2026-09-18 — The return still credits the customer's OLDEST outstanding
invoices, not specifically the ones ticked while collecting — That is how an
approved return has always been applied (aging, both apps), and the owner
asked for it to "cancel from the total". Tying a return to particular
invoices would need a `grv_orders` table and a second allocation rule on both
apps.

2026-09-18 — The GRV field on the phone's collection sheet is now shown to
every role — It was manager-only there and open to everyone on the web. It
is now a request that needs a manager's approval either way, so there is
nothing for a salesman to abuse by typing one.

2026-09-18 — A collection that is nothing but a return writes no payment —
Cash 0, discount 0, GRV 250 creates the request and nothing else. A zero
payment row would be noise in every list.

2026-09-18 — The note text changed from "GRV credit applied: X." to "GRV
request raised: X." on both apps — The old wording claimed something that
was not true then and is not true now. Rows already written keep the old
text; nothing matches on it.

### Editing afterwards

2026-09-18 — Saving an edited payment re-cuts its slices — Editing the amount
changed `payments.amount` and left `payment_orders` alone, so the edit
changed nothing anybody ages against. `reallocatePayment` /
`Payments.reallocate` re-apply cash + discount to the invoices the payment
was already on, oldest first, then the customer's others. Each invoice's room
is what it owes WITHOUT this payment, so a confirmed payment's old slices do
not crowd out its new ones — Rejected: a screen for re-picking invoices by
hand, which is a bigger feature than "make it editable".

2026-09-18 — Managers and admins can edit a payment's discount and status;
a collector editing their own payment cannot — The collector's existing right
to correct their own entry (and the manager being told) is unchanged. On the
phone admins were locked out of payment editing altogether
(`isManager` without `isAdmin`); fixed.

2026-09-18 — Managers and admins can edit a return after entry — amount,
note and products, pending or approved — and remove a pending one — There was
no update or delete policy on `grv_items` at all, so a typing mistake was
permanent. Correcting the lines of an APPROVED return moves stock by the
difference (three cartons corrected to two takes one back off). An approved
return cannot be removed: it has moved stock and credited a customer, and the
way to undo that is to correct it.

2026-09-18 — NOT built: changing which customer a payment belongs to — "Make
sure everything is editable" was read as every figure and field on the
record. Moving a payment between customers re-cuts slices across two ledgers;
the safe way to fix that mistake today is to set the payment to 0 / pending
and log it again under the right customer. Say if it is wanted.

2026-09-18 — Approving a return twice no longer restores stock twice —
`approveGrv` / `Grv.approve` read the status first.

2026-09-18 — The GRV report gained "Returned products" (both apps) — approved
returns only, grouped by product, with a CSV. The owner named "the GRV product
report"; the existing tab listed returns by customer and had no product in it
anywhere, so there was nothing for the products a manager enters to feed.

### Route planning

2026-09-18 — The phone already had a route planner; it opened empty — More →
Planning, for managers and salesmen. It built nothing until a city was typed,
so nobody ever saw a route, which is what "the page is not there" was. It now
opens on a recommended route, and the city is an optional filter.

2026-09-18 — Collecting money ranks first on both apps, from real balances —
Tiers: overdue, then "payment to collect" (owes anything, not yet overdue),
then the idle tiers. The web ranked by the face value of old invoices and the
phone by a sum of order totals; both ignored payments, so they sent people to
collect from customers who had paid. Both now read the shared aging (after
confirmed payments, discounts and approved returns), judged per invoice
against the customer's own overdue threshold.

2026-09-18 — Today's hand-arranged route is remembered on the device, not in
the database — localStorage on the web, UserDefaults on the phone, keyed by
day and by whose route it is, with "Back to recommended". It is one person's
working order for one day. A table would be a new thing to secure and sync
for something nobody else reads — Rejected: a `routes` table.

2026-09-18 — On the phone, collection stops always come before the rest, and
nearest-neighbour ordering runs separately inside each group — Ordering purely
by distance could put the biggest overdue account last. Only the first 12
stops are geocoded (Apple rate-limits it) and the list is capped at 25, with a
line saying so. Once a route is edited by hand, the person's order wins until
they go back to recommended.

2026-09-18 — Phone planner details decided by the engineer, recorded for the
owner: an "All salesmen" row in the manager's picker (as the web has);
removed stops are remembered for the day; the idle tiers were fixed to match
the web (60+ days was unreachable because 30+ was tested first); every leg of
the route is now drawn, not only the first. KNOWN GAP: the phone's customer
list does not carry `is_active`, so an inactive customer can appear on a
phone route; the web filters them out.

### Imports

2026-09-18 — One definition of each sample sheet per app (lib/importSamples.ts)
— The same four samples existed twice on the web (the screen and Settings →
Data) and had already drifted. Each lists every column its importer reads,
marks only the truly required ones, and fills every cell with an example.

2026-09-18 — Customers' District, Address and VAT No are no longer starred as
required — The importer has only ever required Code and Name; the sample said
otherwise.

2026-09-18 — For a customer or product that already exists, a column left out
or a cell left blank KEEPS what is stored — The upsert wrote defaults for
anything missing, so importing a sheet of SKUs and stock counts reset every
price to zero, and a sheet of codes and phone numbers wiped every address.
Defaults now apply only to new rows. Stock already worked this way.

2026-09-18 — A starred header uploads — The sample writes `Code*`; the parser
kept the star, matched nothing, and refused the one file that should always
import.

2026-09-18 — New optional columns: customers take Country, Salesman (by name
or username; an unknown name is reported back) and Active; products take
Active; orders take PO Number and Note (the note is appended to the
"Imported (…)" manager note).

### Statement PDF

2026-09-18 — The statement is drawn from the invoice's own letterhead and
palette, not a copy of them — lib/pdf/statement.ts imports the page, colours
and letterhead from lib/pdf/invoice.ts. It also paginates: the old one
stopped drawing at the foot of page one and printed the closing balance of
rows it had silently left out.

### Per-product discount

2026-09-18 — The manager's per-product discount is stored as the price it
produces; there is still no discount column on order_items — The 2026-09-04
decision stands: a line charges its unit_price, and the invoice's Discount
column is the gap between list price and that. "Disc %" in the order's line
table (manager/admin only) sets unit_price = list × (1 − N%), and reads back
as the gap. The server works it out from the list price it reads itself and
refuses anyone who is not a manager — Rejected: a `discount_percent` column,
which would give an order two answers to "what does this line charge".

2026-09-18 — Consequence accepted: a discount is measured against TODAY'S
list price — If the list price changes after the order is written, the
percentage shown changes with it. The invoice's Discount column has always
worked this way.

### The customer's old price

2026-09-18 — One rule, `resolveLinePrice`: a price written on the document >
the price this customer was last billed > list less the customer's standing
discount > list — It was written out three times and one copy had drifted:
adding an article to an order already written ignored the customer's standing
discount, so the same article cost one price on a new order and another when
added afterwards.

2026-09-18 — A remembered price of zero is not a price — It is what a free
sample or a mis-keyed line leaves behind, and honouring it would bill that
customer's next order at nothing. It falls through to the discount or the
list price.

2026-09-18 — FOUND by the new live check: no customer has an old price yet —
`npm run test:prices` reads the live book (read-only): 530 billed orders, 0
billed lines, 0 remembered prices. The order history was loaded without its
line items, so there is nothing to remember a price from. Old prices start
from the first order approved in the app. To have them for past invoices the
historical invoice LINES need importing — that is a data job for the owner to
decide, not something done here.

### What the iPhone engineers decided on 2026-09-18 (logged here; the iOS project has no log of its own)

2026-09-18 — The phone retries a payment insert only when the DATABASE refused
it, never on a network error — A timeout may mean the row was written; retrying
could log the same collection twice. The web retries on any error and should
probably follow.

2026-09-18 — `Grv.delete` checks the return is pending BEFORE removing lines —
The web removes lines first, which would strip an approved return's lines
before the header delete is refused. Worth mirroring on the web.

2026-09-18 — The phone's statement is drawn from the PHONE's invoice, which is
not the web's — The phone's invoice has no logo, no brand-blue company name,
no shaded title bar and no brand strip, and none of those assets is in the iOS
bundle. "Similar to the invoices" was therefore honoured per app. Giving the
phone the web's letterhead means changing the phone's invoice and adding
assets, which is the owner's call.

2026-09-18 — FOUND and fixed on the phone: AMOUNT DUE on the statement was the
SUM of the running-balance column — Three unpaid invoices of 100 printed
AMOUNT DUE 600. It is the closing balance now, on the PDF and the Excel.

2026-09-18 — On the phone the order-wide discount slider still applies on top
of a customer's old price; on the web a standing discount applies only when
there is no old price — Kept as found and commented, because changing it
reprices orders. The zero-price guard and fil rounding were added on both.

2026-09-18 — Disc % on the phone is a column on iPad and a field under the
price on iPhone, and exists in the two places a line price is editable
(NewOrderView, ManagerOrderEditorView) — In NewOrderView price editing is
manager-only, so an admin sees Disc % read-only there; widening that is a
who-may-edit change (rule 1).

2026-09-18 — Phone imports: PO Number and Note are in the orders sample but not
yet carried — The phone's order import fills ONE new order in NewOrderView from
Article/Quantity/Price; carrying invoice grouping, customer, salesman, PO and
note needs a real bulk importer. The sample matches the web's so one sheet
serves both.

2026-09-18 — Phone imports write per-row updates plus a bulk insert, not an
upsert — A full-row upsert would have to read `cost`, which staff sessions are
not granted. Same outcome, no cost read. A stated cell that is not a number is
treated as "not stated" (the web writes 0) so a typo cannot zero a price.

## 2026-09-18 (second round) — statements by what is owed, FAB, and slow photos

2026-09-18 — The statement people are sent lists only what is still owed; a
separate "Paid statement" lists what has been settled — Owner's request. The
default scope of every statement download (PDF, Excel, shop, group) is now
`outstanding`; `scope=paid` is the button beside the Paid row; `scope=all` is
the old full ledger, still answered, no longer offered. Nothing was removed:
outstanding + paid is every invoice.

2026-09-18 — "Settled" on a statement is decided by the shared aging, and the
goods-return rows are left out of a scoped statement — The customer sheet
already splits invoices into owed and Paid using aging (after payments,
discounts and approved returns applied oldest-first). Using the same split
means the statement and the screen never disagree about which invoice is paid.
Aging has already folded each approved return into "received", so listing the
return rows too would take the credit off twice.

2026-09-18 — Statement files and Excel tabs are named after the customer —
"Statement M&SAVE SUPERMARKET LLC (20417) 18.09.2026", as the owner's own
sheets are ("M&SAVE_31.08.2026"). They were "Statement-20001-2026-09-18". The
name is also the largest text in the Bill To box and is repeated on
continuation pages.

2026-09-18 — Bank details are First Abu Dhabi Bank, printed exactly as the
owner's sheet prints them — The IBAN (AE09 0351 0013 2711 9433 001) passes its
checksum. FLAGGED TO THE OWNER: the sheet's "ACCOUNT NO" line ends …000 while
the account number inside the IBAN ends …001. Printed as provided; one of the
two is probably a typo on the sheet, and it is on every statement.

2026-09-18 — Product photos: the server now remembers what it has fetched —
Each grid tile cost five network trips in a row: verify the token, read the
staff row, read the photos-folder setting, ask Drive for the thumbnail's link,
fetch the thumbnail. The 12 September thumbnail change is what made it slower
than before: fewer bytes, but two calls to Google per tile instead of one.
Now: thumbnail bytes are held in memory by file and width (48 MB ceiling,
least-recently-used first out, 12 h), thumbnail links for 45 minutes, the
folder id for 5 minutes, identical concurrent requests share one fetch, and
uploading a photo clears it all. A repeat tile costs no call to Google for
anybody — Rejected: a CDN or image service (a new account, cost discipline);
rejected storing thumbnails in the database.

2026-09-18 — A login that was just verified is remembered for one minute, in
the photo route ONLY — By a SHA-256 of the credential presented, never the
credential; only a successful check writes to it, so a forged token never gets
in (verified: 401 twice running). Consequence accepted: a member of staff who
is deactivated can load product PHOTOS for up to a minute longer. Nothing that
reads or writes business data uses this shortcut.

2026-09-18 — NOT measured: the photo speed-up could not be timed from the
development machine, because the Drive credential would not authorise outside
the running app and the app sits behind a login. The change was verified by
build, by reasoning about the call count, and by confirming the route still
refuses strangers. The owner's own eyes are the measurement.

### The phone's half of the second round (2026-09-18)

2026-09-18 — FOUND: the phone never sent a width for a grid photo — Every tile
downloaded the full-resolution original and shrank it on the handset. The
12 September note that "the phone already did this correctly" was wrong. Tiles
now ask for 256 or 400 px (tile size × screen scale) and the article sheet for
1024. This, more than anything on the server, is why photos were slow on the
phone.

2026-09-18 — One photo pipeline for the whole phone app — Seven screens each
made their own DriveClient with its own memory cache, in-flight table and "no
photo" list, so opening an article re-asked for a picture the grid had just
shown. Now shared: at most 6 requests at a time, newest first (what is on
screen beats what scrolled past), off-screen tiles cancel, decoding happens
off the main thread, thumbnails are saved as received instead of re-encoded,
the session token is reused for up to 5 minutes, and only a real 404 marks a
SKU as having no photo (an offline moment used to blank it for the life of the
screen).

2026-09-18 — Consequence accepted: iPad tiles wider than ~400 px get a 400 px
image where they used to get 512 — marginally softer, a quarter of the bytes.

2026-09-18 — The phone's customer sheet GAINED a "Paid orders" row — The owner
asked for the paid-statement button "near the paid collapsed row". The web has
that row; the phone only had an unused flag for one. It was built as the web
has it (collapsed, count and total) with the button on its trailing edge.
Salesmen see it too, since they use the same sheet read-only. It is a new
section on that screen, added because the request names it.

2026-09-18 — On the phone the customer's name repeats on EVERY continuation
page, including one holding only the totals; the web repeats it only where the
table continues — harmless, noted so the two are not "fixed" back and forth.

## 2026-09-18 (third round) — Salesman-wise statement

2026-09-18 — A salesman's statement is aged from the WHOLE book and filtered
afterwards — It lists every invoice, from orders that salesman took, that
still has a balance. Aging puts a customer's approved goods return against
that customer's OLDEST invoices; ageing one salesman's orders on their own
would put the credit on that salesman's invoices even when the customer's
oldest were sold by somebody else, and this report would stop agreeing with
the customer's own statement. (`fetchOutstandingInvoices` has a `salesmanId`
filter with exactly that flaw; the Payments page's salesman-scoped tiles use
it. Left alone — it is a different screen nobody asked about — but noted.)

2026-09-18 — A manager or admin opens anyone's; a salesman only their own; the
warehouse not at all — Enforced in the route, not only in the screen. The
picker lists managers and admins too, labelled, because their orders are owed
on as well (2026-09-04).

2026-09-18 — Overdue is marked with the word, not a colour, on the PDF — It is
printed in black and white and handed across a desk. Overdue is judged against
each customer's own threshold, as everywhere else.

2026-09-18 — On the web the report lives in Reports, which only managers and
admins can open — The route answers a salesman asking for their own, which is
what the phone uses; the web has no salesman-facing screen for it yet. Say if
one is wanted.

2026-09-18 — The phone's salesman statement: where it lives and how it differs
— A new "Salesman Statement" tab in the financial reports (manager/admin), and
for a salesman "My outstanding statement" in a menu on the Sales screen, since
only the manager's dashboard opens the reports. Differences from the web, all
following the phone's existing statement: "MMM d, yyyy" dates, no brand strip
(the phone has none), Excel as the HTML .xls the customer statement already
produces. The picker includes INACTIVE users — an ex-salesman's invoices are
still owed. Customer thresholds are read straight from the database with nil
meaning 90; the phone's Customer model maps nil to 30, which would have
disagreed with the web.

2026-09-18 — RISK, not fixed, affects every balance on both apps: aging reads
`orders` in one unpaged request — PostgREST caps a response at 1,000 rows by
default. The book has 530 billed orders today. Past 1,000 counted orders the
oldest or newest would silently fall off every aging figure, statement,
planning rank and this report. `fetchOutstandingInvoices` (web) and
`Aging.fetchOutstandingInvoices` (phone) both need paging before then. Found
while building the salesman statement; flagged to the owner rather than
changed at the end of a long day, because it touches the most-read function
in both apps and deserves its own tested change.

2026-09-18 — Both apps are committed; neither could be pushed — The web's
remote, github.com/FGTacounts/famlist-billing-web, answers "repository not
found" to both GitHub accounts signed in on this Mac (PROJECT-FALCON,
bilal-ajnaz), and no `origin/main` has ever been fetched here. The iPhone
project has no remote at all. No repository was created and no remote was
changed: where the code lives is the owner's decision.

## 2026-09-19 — Reads that grow are paged, on both apps

Closes the 2026-09-18 "RISK, not fixed" entry above.

2026-09-19 — The ceiling is real and it is 1,000 — Checked read-only against
the live project (isdeheipdfmwzmmnnidr): `products` holds 1,604 rows and one
request for 5,000 of them came back with exactly 1,000, no error and no flag.
The book has 531 orders, 17 allocations and 16 payments today, so no balance
has been wrong yet.

2026-09-19 — One helper per app, and it knows nothing about Supabase —
`lib/paging.ts` (`fetchAllPages`, `fetchAllForIds`) and the phone's
`Paging.swift` (`Paging.fetchAll`). Each takes a closure that fetches rows
`from…to` and loops 0–999, 1,000–1,999 … until a page comes back short. Kept
free of any database import so it can be tested against a stand-in that caps
every answer at 1,000, the way the real one does: `npm run test:paging` and
`BillingTests/PagingTests` both prove 2,500 rows come back complete, in order,
in three requests, and that an error on a later page throws rather than
passing half a ledger off as a whole one.

2026-09-19 — Every paged query is ordered by something unique — `id`, or for
`payment_orders`, which has no id column (checked: 42703), by `payment_id`
then `order_id`. Without an ordering the database may return the same row on
two pages and leave another out. `buildSalesmanStatement` already paged its
order ids but without an ordering; it now has one.

2026-09-19 — Rows are de-duplicated by key as well — Paging is by position, so
an order or allocation inserted between two requests pushes the last row of one
page onto the start of the next. Seen twice, an allocation would be counted
twice and a customer shown as having paid more than they did. The helper drops
the second sighting when given a key. The opposite case — a row deleted between
requests, so one is skipped — is not covered; it needs a delete in the second
or so a read takes, this app reverses rather than deletes, and the aging cache
holds a result for ten seconds at most. Keyset paging (`id > last`) would cover
both and was not used because the owner asked for `.range()`, and because
`payment_orders` has no single column to key on. Say if it is wanted.

2026-09-19 — Id lists are chunked at 200 as well as paged — The ids travel in
the URL. The phone already chunked; the web did not everywhere. Found while
comparing old and new code against the live book: the web's `fetchPaidByOrder`
given all 530 order ids in one URL came back with NOTHING (the request fails
and that function has always swallowed the failure), where the chunked one
finds the 17 paid orders. The Orders list calls it with the rows on screen, so
whether anyone saw an empty "Received" column depends on how many were showing.

2026-09-19 — What was paged. Web: `buildOutstandingInvoices` and
`fetchPaidByOrder` (aging.ts); `buildStatement` and `buildSalesmanStatement`
(statement.ts); `fetchGrvs`, `fetchApprovedGrvCreditByCustomer`,
`fetchGrvProductReport` (grv.ts); the last-order read in `fetchRoutePriorities`
(planning.ts) — unpaged and newest-first, it would have kept the newest 1,000
orders of the whole book and ranked every customer whose last order was older
as "never ordered"; and in dashboard.ts the 25-month revenue read, both
gross-profit reads, `orderItemCounts`, the payments chart, top customers, the
two confirmed-payment totals and sales by category. Phone: all of Aging.swift;
the two aging reports, the P&L and the GRV report in FinancialReportsView;
the returns on a customer statement; `Grv.productReport`; and
`AppDataManager.fetchOrdersAsync` — the phone's one load of every order and
EVERY order line, which its statements, planning and dashboards are built
from, and whose lines would have passed 1,000 long before the orders did.

2026-09-19 — Nothing about money changed — Same statuses counted, same
confirmed-only rule, same allocation slices, same oldest-first returns, same
ten-second aging cache and the same keys into it. Where a read used to swallow
a failure (the Orders list's received column, the statement's received column,
the GRV list's line values, sales by category) it still does; where it threw,
it still throws. Proven rather than asserted: old and new `aging.ts` were run
side by side, read-only, against the live book — whole book outstanding (529
invoices, AED 1,225,788.87), including settled (530), one customer, one
salesman (155) — and every invoice's total, paid and balance matched.

2026-09-19 — The phone's two aging reports now take "paid per order" from
`Aging.fetchPaidByOrder` instead of each making the same sum themselves from a
single page of allocations and a URL carrying every order id. Same sum, one
place. They still do NOT apply approved goods returns, unlike every other
aging figure in both apps — that is a money rule, it was not asked about, and
it was left alone. Flagged.

2026-09-19 — If Supabase's "Max rows" is ever LOWERED below 1,000, every page
would look short and reads would stop early again. The page size in
`lib/paging.ts` and `Paging.swift` has to come down with it. Raising it is
harmless.

2026-09-19 — NOT fixed, and live today: the product list — `fetchProductsServer`
(lib/products-server.ts) reads `products` in one request ordered by SKU. There
are 1,416 ACTIVE products, so the last 416 by SKU are missing from any full
listing right now (search still finds them, because it filters on the server).
The phone's product load was not checked. Outside what was asked, touches a
different screen on both apps, and wants its own tested change — flagged to the
owner rather than slipped in. Same for the other unpaged reads this change did
not reach: lib/queries/reports.ts, payments.ts and orders.ts on the web; and on
the phone Payments.swift, PaymentsView.swift, SalesView.swift,
ManagerDashboardView.swift and SettingsView.swift.

2026-09-19 — `npm run test:tenancy` still fails on `order_items_safe` and on
nothing else — the same known failure as before (its RUN-ME has not been run).
This change adds no table, view or policy.

## 2026-09-19 — The product list is paged, on both apps

Closes "NOT fixed, and live today: the product list" in the 2026-09-19
section "Reads that grow are paged, on both apps". That section, `lib/paging.ts`
and `scripts/test-paging.mjs` were written on branch
claude/wonderful-heyrovsky-936d2b and were still uncommitted there when this
was done; the helper, its test and the `test:paging` script were copied here
byte for byte so the two branches merge without a difference in them. Both
branches append to the end of this file, so merging them will stop on this
file: keep both sections, that one first.

2026-09-19 — What was wrong, measured — Read-only against the live project
(isdeheipdfmwzmmnnidr): `count: exact` says 1,604 products, 1,416 active. The
one-request read `fetchProductsServer` made returned exactly 1,000 of the
1,416. The 416 missing were the last by SKU, from every full listing built on
it: the Products page once its full list replaced the first screenful, the
"all products" list behind a new order, import-order-lines' SKU matching, the
Drive photo browser, the Settings data sheet, the Excel and PDF exports, the
photographed-order scan's catalogue, and the dashboard's sales-by-category
lookup (which asks for inactive ones too: 1,000 of 1,604).

2026-09-19 — Web: `fetchProductsServer` pages the whole-list read through
`fetchAllPages`, ordered by `sku` then `id` and de-duplicated on `id`. `sku`
is already unique (imports upsert on it), so `id` changes no row's position;
it is there so the ordering is unique by construction rather than by a
constraint this file cannot see. When `opts.limit` is given the read is still
ONE request of that many rows — the first screenful must not wait for the
catalogue — and a `limit` above 1,000 would still be cut to 1,000; nothing
asks for one (the only caller sends 50). The is_active, search and stock-group
filters are the same filters, applied to every page. The column-fallback retry
is the same: any error, on any page, retries the whole read with the columns
that have always been there, and a stock-group filter still throws rather than
being silently dropped. A search or a stock group comes back in one short
page, so they cost one request as before.

2026-09-19 — Phone: `AppDataManager.fetchProductsAsync` was the same single
request — on both its paths, the `products_safe` view and the raw-table
fallback — so the phone's catalogue, and the order screen built from it, had
the same 1,000 of 1,416. Both paths now go through `Paging.fetchAll`, `sku`
then `id`, keyed on `id`. What decides which path is used did not change: any
failure reading `products_safe` still switches the session to the raw table
without cost.

2026-09-19 — No pricing, cost or stock rule changed — Same column lists per
role on the web (MANAGER_COLS / RESTRICTED_COLS), same view-or-table choice on
the phone. Checked rather than assumed: through the new code a salesman
session's 1,416 rows carry no cost and no override figure; a manager's carry
them.

2026-09-19 — Proven read-only against the live database, by running the real
`fetchProductsServer` (not a copy of its query) under Node: active list 1,416
= the database's own count, 1,416 distinct ids, for a manager and for a
salesman; with inactive included 1,604 = count; `limit: 60` returns 60 and
they are the head of the full list; the first 1,000 rows are the same rows in
the same order as the old read returned; search finds the last SKU. The
phone's query shape (is_active, `sku` then `id`, `.range`) was run the same
way against both `products_safe` and `products`: one request 1,000, paged
1,416, count 1,416. The phone itself was not signed in and driven; its build
and unit tests pass.

2026-09-19 — NOT fixed, found while looking, live today because `products`
is already past 1,000:
- Web `lib/job-runners.ts` order import reads every product
  (`id, sku, description, price, cost`) in one unordered request to match
  SKUs: about 600 products, and not predictably which, cannot be matched.
- Web `existingProductSkus` (same file; scan-articles preview and its
  save-time re-check) reads every SKU in one request, so an existing SKU can
  be offered as new. The unique SKU should then refuse the insert — the whole
  batch, not the one row.
- Web `fetchStockSnapshot` (lib/queries/reports.ts) — the stock valuation
  report sums 1,000 of 1,604 products. A money figure that is short today.
- Phone stock report (FinancialReportsView, `products` where active, by SKU):
  1,000 of 1,416, same understatement. It counts active products only where
  the web counts all of them; that difference is older than this and was left.
- Phone `ManagerProductsView` product insights: `products (id, sku)` in one
  unordered request, and `purchases` in one request, so VAC / China / days
  since arrival are blank for products outside the 1,000.
- Phone Settings backup (SettingsView): customers, products, orders, payments
  and expenses are each ONE request. The backup file holds 1,000 of 1,604
  products today and will lose orders at 1,000 (531 now). A backup that is
  quietly not whole is the worst of these.
Each wants `fetchAllPages` / `Paging.fetchAll` with `.order("id")`, and its own
check. Not slipped in here: the owner asked for the product list and a report.

2026-09-19 — Customers: 355 rows, nothing wrong today. Whole-table reads that
will need paging before 1,000: web `fetchCustomers` (ordered by `name`, which
is not unique — it needs `id` as a second key when paged), `nextCustomerCode`
(reads every code to find the highest; past 1,000 it could offer a code
already in use), the order-import job's customer lookup, `fetchRoutePriorities`'
customer read, and the customer form's group-name list; phone
`fetchCustomersAsync` (by `name`) and the Settings backup above. Reads filtered
by an id list (`.in("id", …)`) are bounded by the list and are chunked where
the list can be long; product and customer imports already chunk at 500.

2026-09-19 — `npm run test:tenancy` fails on `order_items_safe` and on nothing
else — the same known failure; its RUN-ME has not been run. This change adds
no table, view, policy or column.

2026-09-19 — This Mac's `xcode-select` points at the Command Line Tools, so a
bare `xcodebuild` refuses to run. Changing it needs an administrator password
and is a system setting; builds were run with
`DEVELOPER_DIR=~/Downloads/Xcode.app/Contents/Developer` instead. With
`-quiet`, Xcode 27.1 prints "error: the following command failed with exit
code 0" beside ordinary deprecation warnings in files this did not touch; the
build exits 0 and produces Billing.app.

2026-09-19 — Scope for "make the app fit for the iPhone Duo" — There is no
spec section naming the foldable iPhone Duo, so per rule 2 I stopped and
asked before building anything. The owner asked for everything possible:
both layout adaptation (existing screens reflow when the fold changes) and
behavior fit for a device whose usable width changes at runtime, not just a
cosmetic pass. Scope is the iPhone app only (Billing/Billing/); the web app
has no foldable-equivalent surface. Inventory taken before any change: no
`UIScreen.main`, no `AppDelegate`/`UIApplicationDelegate`, no orientation
API usage anywhere — the app is already pure SwiftUI scene lifecycle, which
is the hard part of foldable readiness and was already done. `horizontalSizeClass`
already drives the phone/pad-style layout switch in ManagerDashboardView,
SalesmanDashboardView, WarehouseDashboardView, SalesView, and ~15 other
files, and is a live environment value, so those should already adapt when
the Duo unfolds (compact -> regular) without changes. Concrete gaps found,
being fixed as separate small steps rather than one large change: (1)
`AppPlatform.isMac` in Constants.swift is idiom-based and won't flip on
unfold since `UIDevice.current.userInterfaceIdiom` stays `.phone` on a
folded/unfolded iPhone — two call sites in ManagerDashboardView gate wide
layout on it instead of on sizeClass; (2) 14 sheets still use the deprecated
`NavigationView`; (3) AppNavigation's sidebar is pinned to 64/224pt and
won't use extra unfolded width; (4) several report/table views
(FinancialReportsView, SalesView, ManagerDashboardView, AppNavigation,
ManagerProductsView) size columns with fixed pixel widths instead of
proportionally, so they won't use the extra width either. Working through
these one at a time per the "small steps, report, wait" rule rather than as
one sweeping change.

2026-09-19 — Duo readiness step 1: NavigationView -> NavigationStack (iPhone
app) — Migrated all 14 `NavigationView { ... }` sheet/full-screen-cover roots
to `NavigationStack { ... }` (AddCustomerSheet, AddArticleSheet, AIScanView,
ArticleDetailSheet, ManagerProductsView x2, ManagerCustomersView,
ManagerDashboardView x4, NewOrderView, SalesmanOrdersTab, SalesView). Checked
every site first for `NavigationLink`, `.navigationViewStyle`, `EditButton`,
and double-wrapping before changing anything — all 14 were self-contained
sheet roots with only `.navigationTitle`/`.toolbar`, so this is a behavior-
identical rename, not a layout change. `NavigationView` forces single-column
even on a wide unfolded screen; `NavigationStack` doesn't carry that
constraint (this app already hand-rolls its own sidebar for wide layouts
rather than using NavigationSplitView, so no further change follows from
this by itself — this step only removes the deprecated/legacy-behavior API).
Found `ArticleDetailSheet.swift` has zero call sites anywhere in the
codebase while checking this — dead code, left alone since removing it
wasn't asked for.

2026-09-19 — Duo readiness: closing out the inventory, most items were false
positives — Checked the remaining candidates from the 2026-09-19 inventory
before changing anything else: AppNavigation's 64/224pt sidebar is a
standard fixed-width nav rail (same pattern as Finder/Mail), not a bug.
ManagerDashboardView's two `AppPlatform.isMac` gates already fall back to
reasonable single-column layouts on unfold (one of the two already branches
on sizeClass separately for a stacked layout; the other's plain list isn't
broken, just less differentiated). The fixed-pixel table columns in
FinancialReportsView/SalesView/ManagerDashboardView/ManagerProductsView all
sit inside `ScrollView(.horizontal)` with one flexible text column already
absorbing extra width — unfolding already shows more columns with zero
changes; making them proportional would look worse, not better. Net result:
the only real change from this pass was the NavigationView -> NavigationStack
migration (already done, build-verified with `BuildProject`). Not making
further changes rather than manufacture busywork against a codebase that
was already close to Duo-ready.

## 2026-09-19 — Approving from the Inbox, and telling the manager there is something to approve

2026-09-19 — Every request in the Inbox has an Approve button on its own row —
Owner's request: "all requests. in the inbox add an approve request button."
An order edit request and a pending goods return used to be rows that only
opened the order or Payments; the customer-change request already had its two
buttons. Approve on an edit request is the same call as "Grant edit" on the
order (`/api/orders/grant-edit`, manager-only on the server); on a return it
is `approveGrv`, the same one Payments uses. The rest of the row still opens
the order or Payments, which is where Deny, the products and the amount live —
Rejected: a Deny beside it. It was not asked for, and turning an edit request
down is one tap away on the order.

2026-09-19 — A return raised at collection can be approved from the Inbox
before its products are entered — The 2026-09-18 entry says the manager opens
it, enters what came back, and approves. That order is no longer forced: the
owner asked for approval on all requests, Payments already approved from its
list without opening the return, and `saveGrv` corrects the lines of an
approved return and moves stock by the difference. What is lost if nobody goes
back is the products on the GRV product report, not the money — the credit is
the agreed `amount` either way.

2026-09-19 — "Apply" on a customer-change request now reads "Approve" — One
word for one act across the three kinds of request. Nothing about what it does
changed.

2026-09-19 — Raising a request notifies every active manager and admin — An
edit request, a customer change and a goods return each waited for a manager
to happen to open the Inbox; none of the three produced a notification. They
now do, from the functions that raise them (`requestEdit`,
`requestCustomerChange`, `createGrv`, `createGrvRequest`) rather than from the
screens, so a second screen raising the same request cannot forget to. Same
rule as the order notifications: best-effort, never undoing the request, and
never sent to the person who raised it. No database change — staff could
already write a notification for a colleague, which is how order handovers
reach the salesman.

2026-09-19 — SUPERSEDED the same day by "The admin decides which actions need
approval", below; the owner asked for it next.
2026-09-19 — Not built yet: the admin switches for which actions need a
request — The owner asked for them in the same message. Switching a request
off means a salesman or the warehouse writes what only a manager can write
today (the customer record, an approved order's stock, a return's approval),
and that is decided by the database's policies, not by hiding a button. It
needs its own RUN-ME SQL and the owner's answer on which actions are on the
list, so it is a separate step.

## 2026-09-19 — The admin decides which actions need approval

2026-09-19 — Three switches, because there are three requests — Owner's
request: "in the settings of the admin. He can enable and disable which all
features are needed to be requested and not requested." The app raises exactly
three things as a request to a manager: a customer change, the warehouse
reopening an approved order, and a goods return. Those are the list. Order
approval itself (pending → accepted → approved) is not on it: that is the
pipeline, not a request, and approving is what issues the invoice number —
Rejected: a generic "permissions matrix" of every action per role. Nobody
asked for it and every cell would be a new way to get the money wrong.

2026-09-19 — The switches live in `app_settings` and default to ON — Three
booleans (`customer_changes_need_approval`, `order_edits_need_approval`,
`goods_returns_need_approval`) on the one settings row, beside
`delivery_enabled`, which is the same kind of answer. ON is today's behaviour,
so running RUN-ME-26 changes nothing by itself, and an app that cannot read
the columns treats everything as needing approval. A missing setting must
never quietly remove a check.

2026-09-19 — The database enforces each switch; the apps only choose which
call to make — Hiding "Request edit" and showing "Reopen" would be a button
the database refuses, or worse, one it does not. So: customers get two extra
policies that match only while that switch is off; reopening an order and
finalising a return are `security definer` functions that check the switch,
the caller's role or authorship, and the row's state, then move stock and
status in one transaction. Functions rather than wider policies for those two
because RLS cannot limit a salesman to one column of `products`: a policy that
let them put stock back would let them change a price — Rejected: doing the
non-manager path in a Next.js route with the service key. The phone talks to
the database directly and would have needed its own copy.

2026-09-19 — Only an admin can change them, and a trigger says so — The owner
put it "in the settings of the admin". Managers can already update
`app_settings` (delivery step, theme) and RLS cannot tell columns apart, so a
before-update trigger refuses a change to these three from anyone who is not
an admin. The service role passes: it is the server and the import tools.

2026-09-19 — With returns switched off, a return is final for whoever raises
it, manager included — The function lets the person who raised a pending
return finalise it, whatever their role. A manager raising a return and then
approving their own request, with approvals switched off, would be ceremony.
`approved_by` records that same person: nobody else looked, and the column
should not pretend somebody did.

2026-09-19 — A return that cannot be finalised falls back to a request — If
the switch is off but the function is refused or missing, the return stays
pending and the managers are notified, exactly as when the switch is on.
Nothing is lost and nothing is credited that the database did not agree to.

2026-09-19 — Requests already waiting when a switch goes off stay in the
Inbox — Switching a request off changes what happens to the next one. The
ones already raised still need their Approve; applying them silently because a
setting changed would be the app deciding something a manager had not.

2026-09-19 — The order screen's own edit-request notification is gone —
It wrote "Edit requested / Warehouse requested to edit an approved order" to
every manager from the button's click handler. `requestEdit` now sends the
notification (with the invoice number and the customer), so the handler's copy
would have been a second one for the same event.

## 2026-09-19 — The phone's side of Inbox approval and the approval switches

2026-09-19 — On the phone each pending return is now its own Inbox row — It
was one summary line ("Check Reports → GRV to review") with no action. An
Approve button needs a return to belong to, so the line became rows carrying
the customer and the amount when there is one. The rows are not tappable
beyond Approve: the old line opened nothing either, and navigation there was
not asked for.

2026-09-19 — The phone keeps the requester's note on a customer change — The
web has no such note. Rather than drop it or send two notifications, the note
becomes the notification's body ("<who>: <note>"); the title matches the web.

2026-09-19 — The phone's salesman "Request Edit" still always goes to a
manager — The web only gives that button to the warehouse, and
`reopen_order_without_approval` accepts the warehouse or a manager. The phone
also lets a salesman request an edit (SalesmanOrdersTab). With order edits
switched off that request is unchanged: a salesman putting stock back and
clearing an invoice's totals on their own is a wider permission than the owner
described, so it is left for the owner to decide rather than assumed.

2026-09-19 — The phone's `updateCustomer` now checks the write took — With the
customer switch off a salesman writes customers directly, and a write the
database declines reports success with nothing changed. Without the check it
would look saved until the next sync. Rollback only; no new message.

2026-09-19 — The phone says On/Off where the web says Ticked/Unticked — Its
controls are switches, not checkboxes. Every other string is the web's.

## 2026-09-21 — Picking on the phone un-ticked itself

2026-09-21 — The phone's writes to `order_items` now ask for nothing back
(`return=minimal`) — The Supabase Swift library asks for every column back
after an update or delete. Staff logins are not granted `unit_cost`
(RUN-ME-4), so the database refused the whole write; the phone logged that to
its debug log and nowhere else, and the 2-second refresh on the picking screen
then replaced the tick with what the server had — no tick. Four writes were
affected: the tick itself, removing a line, saving a stock-capped quantity at
approval, and emptying an order from the Trash. It is the same trap that
emptied the product list (WHAT-CHANGED §1) and that the phone's importer
already avoids — Rejected: routing the phone's ticks through the web's
/api/orders/update-picked-qty, which would make picking depend on the web app
being deployed and reachable from the warehouse floor, and would not fit
OfflineOrderQueue, which replays whole orders; rejected granting `unit_cost`
back, which undoes the cost lockdown.

2026-09-21 — A line the database refuses is now reported, not only logged —
`syncOrderItemsInDB` still attempts every line, then throws the first refusal,
so `updateOrder` answers false and the picking screen says "Could not save the
pick" with the database's reason. This is the 2026-09-12 rule ("a rejection by
the database is reported") applied to the lines as well as the header. A lost
connection is still queued, not reported.

## 2026-09-21 — Recently deleted

2026-09-21 — The Trash in Orders is now "Recently deleted", and for a manager
it also lists rejected orders — Asked for by the owner: a manager who deletes
or rejects the wrong order should find it in one place. Restore on a rejected
order is the existing Resubmit (back to Pending, `rejected_at` cleared), so
there is one un-reject rule, not two. Only the label changed; the i18n keys
and the phone's Account → Trash (local drafts, a different thing) did not —
Rejected: moving rejected orders out of the Rejected section, which is where
a salesman fixes and resubmits their own and was not asked to change (rule
1); rejected a new `restore` route for rejections, which would duplicate
Resubmit.

2026-09-21 — A salesman's Recently deleted is unchanged — It still shows only
the orders they deleted. Their rejected orders are already in front of them
in the Rejected section with Resubmit.

## 2026-09-21 — Removing a line after the order is accepted

2026-09-21 — A manager or the warehouse may remove a line while the order is
waiting, picking or packed — Asked for by the owner; the stages and the two
roles were proposed and confirmed. Stock is only deducted at approval, so at
these stages the row simply goes and the totals are recalculated; nothing has
to be put back. From approval on the rule is unchanged: the edit-request flow,
which reverses the stock first. Draft/pending is unchanged too (own order, or
a manager) — Rejected: allowing it at any stage, which would change an issued
invoice and leave its stock deducted; rejected giving it to the salesman after
acceptance, which was not asked for.

2026-09-21 — After acceptance the web removes the line with the admin key,
after checking role and stage in the route — The warehouse holds no write
privilege on `order_items`; its picks already go this way
(update-picked-qty). A delete the row-level rules decline reports success
with nothing removed, which is the failure this avoids.

2026-09-21 — The phone's "Remove from order" is now limited to the same
stages — It was offered on the picking screen at every stage, to warehouse
and manager. It had never worked: the delete was refused for the same reason
the ticks were (see above). Fixing that write would have let a line be taken
off an approved or delivered invoice with its stock still deducted, so the
button now appears only while the order is waiting, picking or packed. This
narrows what the screen offers, not what anyone could actually do.

## 2026-09-21 — Adding a line after the order is accepted

2026-09-21 — Adding follows removing: a manager or the warehouse, while the
order is waiting, picking or packed — The owner asked for "ability to add
items on an order" straight after confirming the rule for removing them, so
it is one rule in both routes, not a second one. The line is priced by
`resolveLinePrice` exactly as before, and deducted at approval with the rest.
Quantity and price edits were NOT widened: nobody asked, and the warehouse
changing a price is a different permission.

2026-09-21 — On the web, adding more of an article whose line is already
ticked takes the tick off — A picked line bills its picked quantity, so the
extra boxes would otherwise never be billed; and nobody has picked them yet.
The phone was left as found: there the same action raises the picked
quantity and the line stays ticked, because its sync never flips a pick
without an explicit tick. The two disagree on that one case; changing the
phone's sync for it was judged riskier today than the disagreement.

2026-09-21 — The phone's "Add article" on the picking screen is limited to
the same stages — Same reasoning as "Remove from order" above: it was offered
at every stage, including on approved and delivered invoices.

## 2026-09-21 — No discount unless a manager gives one

2026-09-21 — The price rule is now: a price a manager states > the customer's
old price > list. The customer's remembered whole-order discount is gone from
it — The owner: "there should be no unnecessary discounts. The manager adds a
discount on the products he wants", and, asked for the order of things, "list
price, then the old price, and then if any discount is applied on that
specific product or the complete order". A manager's order discount used to
be saved to `customer_discounts` and then taken off every later order for
that customer, a salesman's included, with nobody choosing it. This REPLACES
rule 3 of the 2026-09-18 "One rule, `resolveLinePrice`" decision. Both apps.
The live table held 0 rows when this was done, so no customer's prices moved
— Rejected: keeping the remembered discount as a pre-filled suggestion in the
manager's field, which shows a discount that is not applied; rejected
dropping the old price too, which the owner explicitly kept.

2026-09-21 — The manager's order discount belongs to the order it is given
on — It is no longer written to `customer_discounts` or read back on the
customer's next order, on either app. The table and its rows are left alone.

2026-09-21 — Only a manager or admin changes a line's price, and the server
enforces it on the web — Asked and answered ("No, manager only").
`/api/orders/update-item` refuses `unitPrice` from anyone else, and
`/api/orders/create` does not read a non-manager's prices at all: it prices
each line itself from the old price or the list price. The new-order sheet
and the order's line table show a salesman the price as text. A price written
on an imported or scanned document counts only for a manager. This narrows
the 2026-09-04 "a price written on the document wins" decision to managers —
Rejected: trusting the form, which is where a salesman's lower price came in
and printed on the invoice as a discount.

2026-09-21 — Known limit: on the phone this is enforced by the screens, not
the database — The phone writes `order_items` directly, so a salesman's price
is whatever the app sends. Its price field was already manager-only. Closing
that properly needs a database trigger that refuses a non-manager's
`unit_price` change; not written, because it has to let the phone's own
order creation through and deserves its own step.

2026-09-21 — The phone's order-wide discount was already manager-only — The
owner chose "Manager only"; `NewOrderView` already shows it only to
`isManager`. An admin does not get it there (2026-09-18 note) and that was
not widened.

## 2026-09-21 — The billing date becomes its own column, and a manager can change it

2026-09-21 — `orders.billed_at` replaces `updated_at` as the billing date
(RUN-ME-27) — The owner asked for the date on an order to be changeable "like
the salesman", and chose the billing date over `created_at` when shown that
sales, aging and statements read the former. This is the column the
2026-09-04 note said would end "that whole class of accident"; it is now
asked for. Every reader moved: sales and dashboard figures, reports, aging,
statements, the Invoices page, the invoice PDF/Excel and their file names,
and `fetchOrders`' from/to window — Rejected: letting a manager write
`updated_at` directly, which the next edit of any kind would overwrite.

2026-09-21 — It is stamped when the status changes, not once at approval —
That is when the billing date effectively moves today, and
`reports_from_status` defaults to `delivered`, so stamping once at approval
would move every order delivered in a later month than it was approved into
the earlier month. A note, a PO number or a line edit no longer moves it.
Proposed to the owner in those words and accepted.

2026-09-21 — A date set by hand sticks (`billed_at_manual`) — Otherwise the
manager's correction is undone by the next status change. The trigger sets the
flag whenever `billed_at` itself is written, and refuses that write from
anyone but a manager, an admin or the service role. Consequence: the web only
sends `billed_at` when the manager actually changed it, and the phone writes
it as its own small update, never in the whole-header write it makes on every
tick — either would mark every order as hand-dated.

2026-09-21 — One helper decides the column, and rows always carry
`billed_at` (lib/billingDate.ts) — Until RUN-ME-27 is run the column does not
exist and PostgREST refuses the whole request. The helper probes once, and
readers select `billed_at:updated_at` — PostgREST's rename — so the code
below the query reads one name either way. "Missing" is re-checked every five
minutes because a server instance outlives the moment the SQL is run; "there"
is never re-checked. Verified read-only against the live database: the probe
answers 42703 and the renamed select works — Rejected: the select-then-retry
used elsewhere, which at ~25 call sites is 25 copies of the same fallback.

2026-09-21 — NOT changed: the Date column on the Orders list still shows
`created_at` — The owner asked for "the date on orders" to be changeable, and
the list shows when an order was written, which is not the date that was made
editable. Switching the list to the billing date changes what every row shows
and how the list reads against its sort, so it is asked, not assumed.

2026-09-21 — FOUND while checking the fallback: every order was re-dated on
2026-09-19 — One update at 15:56:46.501482 UTC stamped `updated_at` on 537 of
558 orders, all delivered imported invoices with no status history. All 558
orders therefore carried a September 2026 billing date: "sales this month" was
every sale on record and nothing was overdue. It is the 2026-09-04 accident
again. The cause was not found — no RUN-ME file, script or route does a bulk
update of orders. RUN-ME-27 repairs it before filling `billed_at`, by
RUN-ME-11's rule (last status change, else `created_at`), and puts
`updated_at` right too because the deployed web app and the phones in the
field still read it. It also lists any other moment many orders share, leaving
out exact-midnight dates: imported invoices are dated at midnight and up to 13
share one, which is real.

## 2026-09-21 — Multi-select on the Orders list

2026-09-21 — Manager and admin can tick several orders and delete them
together; Delete is the only bulk action — Asked for as "select options" for
the manager; asked which actions, the owner said continue on the suggestion
of Delete alone. Accept and Reject in bulk were not built: each is a decision
about one order. While selecting, tapping a row ticks it instead of opening
it, in every list on the page.

2026-09-21 — A bulk delete is the single delete, once per order, in turn —
Same route, so each order's stock goes back and its payments are released
exactly as they would alone, and one refusal does not stop the rest; the
count that failed is reported — Rejected: a bulk route, which would be a
second copy of the three-consequence delete to keep in step.

2026-09-21 — Selection reaches the lists through React context — Three
components sit between the page and a row (Section, PaginatedOrderSection,
OrderList); a prop through each for one feature was the alternative.

### The phone's side of the billing date (logged here; the iOS project has no log of its own)

2026-09-21 — `Billing/BillingDate.swift` is the phone's copy of
lib/billingDate.ts, and `Order.revenueDate` is now `billedAt ?? updatedAt ??
date` — All ~31 report sites and the statement already went through
`revenueDate` (2026-09-05), so that one line moved them. The aging and the
financial reports name their columns, so they ask `BillingDate.column()`
first, exactly as the web does. The main order list selects `*` into a
Codable, so an absent column just decodes as nil and needs no retry; one row
that carries a `billed_at` proves the column exists (it is NOT NULL).

2026-09-21 — On the phone the Billing date row is hidden until the column
exists; on the web it is shown greyed out — The web already greys out the PO
number before its migration, so it follows that. The phone's editor has no
such pattern and a control that cannot work is worse than none. Manager and
admin only, in ManagerOrderEditorView's customer card.

2026-09-21 — The phone writes the billing date BEFORE the rest of a save, as
its own update — A Save that also changes status would otherwise stamp the
date first and then have it overwritten by hand; written first, the status
change finds a hand-set date and leaves it. It is written only when the day
differs from the day the sheet opened with, so a date that moved underneath an
open sheet is not written back as hand-set. The old time of day is kept; noon
UTC where there was none.

2026-09-21 — Known limits on the phone, not changed — (1) adding to a ticked
line raises the quantity from what the line SHOWS (the picked quantity), the
web from `ordered_qty`; they differ only if the two already differed. (2) If
the un-tick fails on a dead connection, the offline queue replays whole
orders, which never flips a pick, so the tick survives on the server until
un-ticked again. Both are the existing queue and sync rules.

### The phone's multi-select and invoice dates (logged here; the iOS project has no log of its own)

2026-09-21 — On the phone, multi-select is on the manager's All Orders tab
only — That tab lists every order with a status filter, which covers the ask;
New Orders, Warehouse and Delivery have their own tap behaviours. The Delivery
tab is the same view with a preset status, so Select is hidden there. Same
rules as the web: manager and admin, Delete only, `OrderTrash.delete` once per
order in turn, both counts reported. Ticks survive a search or filter change
as on the web, so the count and the confirmation always show the true number.

2026-09-21 — The phone's invoice now prints the billing date, and a real due
date — Its PDF and Excel printed the day the order was WRITTEN as Inv Date and
again as Due Date. The web prints the billing date and that date plus the
customer's overdue-threshold days (90 where there is none). With the billing
date now editable, a manager who corrected it would have got two different
invoices for one order from the two apps. Layout and wording untouched; the
file name's month follows too. This changes a document, so it is flagged to
the owner — Rejected: leaving it, since an invoice whose due date equals its
invoice date was never right.

## 2026-09-22 — The Orders list shows the billing date

2026-09-22 — The Date column on the Orders list, and its newest/oldest sort,
use the billing date on both apps — Asked for ("yes, show the billing date")
after being flagged on 2026-09-21. Sort and column change together so the list
reads in the order it is sorted. `created_at` is no longer shown anywhere on
the list; it remains the order's own field. Consequence until RUN-ME-27 is
run: the column shows `updated_at`, which today is the 2026-09-19 re-stamp for
every delivered order — the same wrong date sales and aging already use, and
the file fixes all three at once.

2026-09-22 — FOUND: RUN-ME-27 was reported run but nothing from it reached
the database — No `billed_at`, no `billed_at_manual`, and the 537 re-stamped
orders unchanged, checked read-only. RUN-ME-26's columns are absent too. The
SQL editor must have refused something; the owner has been asked for the
message. The apps keep working on `updated_at` in the meantime, by design.

## 2026-09-23 — RUN-ME-27 repairs any mass re-stamp, not one moment

The Sales page showed AED 1.2m sale for September. Read against the live
database: the 537 imported, delivered invoices were re-stamped a third
time, at 2026-09-23 17:47:33 UTC, and RUN-ME-27 still has not been run
(no `billed_at` column). Nothing in this repo bulk-updates orders; the
cause is outside the code again. RUN-ME-27's repair looked for the exact
2026-09-19 timestamp and would now have repaired nothing, so it matches
any non-midnight `updated_at` shared by more than 20 orders instead. On
the live data that is exactly the 537 (the next-largest shared moment is
5). No app code changed: the Sales page already filters to this month —
it was fed wrong dates. The low Total GP (AED 1,665) is correct-ish: the
imported invoices have no line items, so only the app's own orders carry
GP.

2026-09-23 — RUN-ME-27 confirmed on the live database: `billed_at` present,
no re-stamped group left (largest shared date is 13 orders at midnight — real
invoice dates), 49 of 558 orders dated September (AED 64,577 before status
filtering), down from all 558.
