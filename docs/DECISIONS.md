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
