# What changed, and what you need to do

Two jobs, in order: the iOS app was made to agree with the web app, then the
web app was compared against the Sheets version you are still running and
the gaps were filled.

**Before anything else:** run
`scratchpad/RUN-ME-7-ios-parity.sql` in Supabase → SQL Editor. Several of
the fixes below only come fully to life once it has been run, and one
thing (cost prices on the phone) stays hidden until it is.

---

## 1. Why the iOS app was not working

The product list was empty on every phone, for every role. Confirmed
against your live database with a real signed-in manager session:

| Request | Result |
|---|---|
| The query the app was making (it named `cost`) | **403, permission denied** |
| The same query without `cost` | 200, products returned |

Staff are no longer granted the `cost` column — that was the deliberate
cost-price lockdown. But PostgREST refuses the *entire* request when one
column is off limits, so the phone got nothing back at all. An empty
catalogue then emptied the article picker, the photo browser, stock figures
and every screen built on them.

The app now reads through a `products_safe` view (a manager sees cost,
nobody else does) and falls back to reading products without cost if the
view is missing. That is why it works today and gets cost back after the SQL.

### Other faults found and fixed on the phone

- **Notes went to the wrong people.** The database routes notes by
  recipient; the phone treated them as belonging to their author. A
  manager's reply came back to the salesman as their own text, and the
  warehouse's note to the manager was filed as a note *to* the warehouse.
- **Invoice numbers were issued when an order was created**, so a cancelled
  or rejected order burned a number and left a hole in the series. Numbers
  are now issued at approval, by the database, gaplessly.
- **"Accept" wrote the wrong status**, so an order a manager accepted on
  their phone never appeared in the warehouse's Waiting queue on the web.
- **Granting an edit request did not put the stock back**, so re-approving
  deducted the whole order a second time.
- **Order lines were deleted and re-inserted on every save**, throwing away
  the cost snapshot (gross profit for that order became unrecoverable) and
  breaking a concurrent picker's ticks.
- **Payments never recorded which invoice they paid.** Only the per-invoice
  allocation counts, so money collected on a phone left every invoice fully
  outstanding on the web. It now allocates oldest-first, like the web.
- **Receivables were computed differently** — unbilled orders counted as
  debt, returns were ignored, age ran from the wrong date. It now uses the
  same rules as the web, in one shared file.
- **Customer change requests went to a table that does not exist**, so a
  salesman's request silently went nowhere. They now go to the same table
  the web app's inbox reads.
- **Creating a staff login required public sign-up to be on** (anyone with
  the app's public key could make an account) and signed the manager out.
  It now calls the web app's admin route with the manager's own token.
- **Silent failures**: a refused payment, a refused stock correction and a
  refused goods return all reported success. They now say what happened.
- Delivery-stage on/off is now one setting for the business, not a
  per-phone switch. Accent colours match the web's palette. Proof photos
  are named the way the web app searches for them.

---

## 2. Brought over from the Sheets app

| Feature | Where it is now |
|---|---|
| **Read a written order with the camera** | New order → camera button beside the barcode and photo pickers |
| **Read a supplier invoice into products** | Products → **Scan invoice** (manager) |
| **Import a day's orders from a spreadsheet** | Orders → **Import orders** (manager), with a sample file |
| **Find orders sent twice** | Settings → Data → *Orders sent twice* |
| **Sort the order list** | Orders → the dropdown beside search (7 orderings) |
| **Price from a target GP%** | Order detail → click the GP figure on a line |
| **Set the order subtotal** | Order detail → click the subtotal |
| **Correct a shelf count while picking** | Order detail → **SOH** column |
| **Team news** | The bell → **Post news** (manager) |
| **Order notifications** | Automatic on every handover — accepted, rejected, picking, packed, approved, out for delivery, delivered |
| **One screen failing no longer blanks the app** | Everywhere |

### Deliberately not brought over

- **Merging one invoice split across rows.** That was a spreadsheet
  write-race. Orders here are rows with their own key and invoice numbers
  carry a uniqueness rule, so it cannot happen.
- **`/api/diag`.** It reported credential diagnostics to anyone, signed in
  or not. Its own comment called it temporary.
- **Draft trash with 30-day restore.** Drafts here live in the database
  rather than in one browser, so clearing a browser no longer loses them.

### Not done, and worth a decision

- Dragging order lines into a custom order. The outcomes it was used for —
  picked items first, sorting by rack or article — are already settings.
- Editing an order's date, and a per-order VAT number that differs from the
  customer's.
- A "best day this month" figure on the reports page.

---

## 3. Two things to look at that I did not change

- **A Google service-account private key is committed inside the iOS app**
  (`familist-497101-12cb1f36bc3a.json`) and ships inside the installed app,
  where it can be extracted. It grants Drive access. A live Gemini API key
  is in `Config.xcconfig` too. Both should be rotated, and the Drive work
  moved behind the server. Rotating keys is your call, so I left them.
- **`WEB_APP_URL` in `Config.xcconfig` is empty.** Creating staff logins and
  changing someone else's password from a phone need it. Everything else on
  the phone works without it; those two actions explain themselves until it
  is set.

---

## 4. Checks that were run

- iOS app compiles clean (`BUILD SUCCEEDED`).
- Web app: types clean, production build clean, 53 pages generated.
- Verified in a browser against your live database: the order sort, the
  Import orders button, the Scan invoice button, and the duplicate check
  (which ran and correctly reported none).
- The product-permission finding above was measured, not assumed.

---

# Round two — 4 September

**Run `scratchpad/RUN-ME-8-stock-floor-and-salesman-expenses.sql`** in
Supabase → SQL Editor. It does two things nothing else can: it puts the four
already-negative stock figures back to zero and stops them ever going
negative again, and it adds the column that lets an expense name a salesman.
Until it is run, the app tells you so instead of failing oddly.

## 1. Stock never goes below zero

Four articles were already negative when I looked: HBG274 at −1, HBG275 at
−12, BG112 at −9, BG108 at −5. Each one came from approving an order for more
than the system believed was on the shelf.

Now: the web app, the phone, imports and manual corrections all stop at zero,
and a database trigger enforces it underneath them, so no future screen can
get it wrong. The SQL sets the four existing ones to zero.

One honest consequence: if an order for five is approved against a count of
two, two come off. If you then grant an edit on that order, five go back on —
nothing records how much actually came off. The count was already wrong in
that case; the warehouse can correct it from the picking screen.

## 2. Expenses can name a salesman

The Salesman tab was filtering on who *typed the expense in*. Logging is
manager-only, so that was always the manager, and the tab was always empty.

An expense now carries the salesman it belongs to, chosen when you log or
edit it — on the web and on the phone. Left blank for anything that belongs
to the business, like rent. The Salesman tab shows what is attributed, with a
picker for one person or all of them, and the spreadsheet import takes a
SALESMAN column matched against staff names.

## 3. The salesman panel on Sales follows its date picker

Picking "Year to date" redrew the graph and left every figure beside it on
this month. Ajnaz read AED 3,601.07 over 2 orders whichever range you chose.

Now the sale total, the orders list, the count, % to goal and amount left all
follow the range. Year to date for Ajnaz reads AED 309,706.01 over 60 orders
— checked against the database directly, it is exactly right. Over a window
longer than a month the goal scales with it and is labelled "Goal (period)";
a month or less keeps the monthly goal, as before.

Two smaller things fixed in passing: every window used to stop four hours
short of the end of the last day (a UTC/local mix-up), so today's orders were
missing from the orders list and the GP%; and one query moved the date range
underneath the others running beside it.

## 4. Whoever bills is linked to a person

Three orders on your database are billed by the manager, not a salesman.
They counted towards the company's total sale but appeared under nobody's
name on the Sales page, so the page did not add up.

- The leaderboard now names everyone who billed. A salesman still always
  appears, at zero if that is the truth; anyone else appears once they have
  billed, with their role beside their name. The team's goal is still the
  salesmen's goals added up, so it has not moved.
- An order can no longer be saved without a salesman — the server refuses it,
  and the picker keeps the order's current salesman on the list even if they
  have left the roster, so saving cannot quietly reassign the sale.
- **On the phone, no order was showing a salesman at all.** The users query
  asked for four columns while the app needs five, so the whole list failed to
  decode and every order lost the name behind it — which is also what emptied
  the phone's leaderboard. Measured against your live database, then fixed.

## Checks run

- Web: types clean, production build clean.
- iOS: `** BUILD SUCCEEDED **`.
- Verified in the browser on your live data: the Sales page, the drill-down
  at 30 days and at Year to date, and the Expense page's new picker.
- The year-to-date figure was recomputed independently from the database and
  matches to the fill (AED 309,706.01, 60 orders).
- Not verified in the browser: the message shown when you save an expense
  against a salesman *before* running RUN-ME-8 — the preview browser stopped
  responding at that point. The behaviour is one line of code and the
  underlying error was measured directly; nothing is written either way.

---

# Round three — 4 September

**Run `scratchpad/RUN-ME-9-overdue-at-90-days.sql`.** Read section 2 of it
before you do — it clears something on 527 orders, and I have explained why
below.

## 1. Why the app was quitting

It is not the current app. All four crash reports on this Mac are the same
fault, and it is in `GoogleSheetsManager` — the old Google Sheets code. That
file does not exist in this project any more; it was left behind in versions
1 to 4. The app installed on your simulator was **built on 5 July**, before
the move to Supabase, and it dies when a spreadsheet row comes back with
fewer columns than it expects.

The current app is now installed over it and running — I launched it and it
sat there quite happily. If it quits again, it will be a different fault and
worth a new report.

I also went through the current source for the same class of mistake: nothing
that can trap. No `try!`, no `fatalError` that anything reaches, and every
force-unwrap left is a fixed URL or a date calculation that cannot fail.

## 2. The login page asks who you are

"I AM A — Salesman · Manager · Warehouse", as the Sheets app had it, on the
web and on the phone. It is a gate, not a label: sign in with a warehouse
account after picking Manager and it says *That account is registered as
Warehouse* and does not let you in. Admin can use any of the three. The
device remembers which one you last used, so the warehouse iPad opens on
Warehouse every morning.

## 3. What Remaining and Overdue actually count

They were wrong, in three separate ways.

**They were measured at 30 days, not 90.** The company setting and every
single customer still said 30 — the old default — so everything older than a
month was called overdue. That is the AED 1,096,342.57 you were looking at.

**The Payments page had its own copy of the sum**, which ignored due-date
extensions completely, while the Customers page and the statements read them.
Three screens, three answers. Payments now uses the same aging as everything
else: confirmed payments off, approved returns off, extensions respected.

**Approving an extension request did nothing.** It set the request to
"approved" and stopped there — it never moved the order's due date, so the
invoice stayed overdue and the salesman was still chased for it. Now it moves
the date, on the web and on the phone.

So, from now on:

- **Collected** — confirmed payments this month.
- **Remaining** — what is still owed and still inside its terms: younger than
  90 days, plus anything genuinely extended.
- **Overdue** — what is owed past 90 days and has not been extended.

A customer can still be given their own terms; 90 is the default behind them.

### The one thing you need to decide

527 of your 535 billed orders carry an "extended due date", and they carry the
*same* one — 526 say 2026-09-03, one says 2026-08-19 — with no approved
extension request behind any of them. That is a mass write, not 527
decisions.

It matters because aging counts from the extension. With those in place, an
invoice from November last year reads as one day old, and almost nothing is
overdue anywhere. Section 2 of RUN-ME-9 clears exactly those two dates and
nothing else. Anything you extend from today on is untouched.

Measured on your live data, here is what the Payments page reads:

| | Remaining | Overdue |
|---|---|---|
| Before (30 days) | 131,669.55 | 1,096,342.57 |
| After (90 days, blanket extensions cleared) | **493,600.70** | **734,411.42** |
| If the blanket extensions are left in place | 1,228,012.12 | 0.00 |

## Checks run

- iOS: `** BUILD SUCCEEDED **`, installed on the simulator, launched, and
  still running — no new crash report. The role picker was tapped through.
- Web: types clean, production build clean.
- The Payments figures above were computed directly against your database, not
  read off a screen.
- Not verified in the browser: the web login's role gate and the new Payments
  header. The preview browser stopped responding in this session; the logic is
  the same on both apps and the phone's half was exercised.

---

# Round four — the iOS screens

Every query the phone makes was checked against your live database, one at a
time, the same way the empty product list was found. **One was broken:** the
Settings → backup export asked `expenses` for a `created_at` column that does
not exist, so the whole request failed and every backup came out with no
expenses in it at all. It reads `updated_at` now.

Everything else — 60-odd queries across every screen — is valid.

Also fixed while going through them:

- **A monthly goal that the database refused looked saved.** Setting a
  salesman's goal or the team goal wrote to Supabase and threw the result
  away. If the write was refused the new figure sat on screen looking
  accepted and came back to the old one on the next device. It now says so,
  on both the Reports screen and the dashboard's goal editor.
- The phone's Collected / Remaining / Overdue already read from the same
  shared aging as the web, so once RUN-ME-10 is in, the two agree without
  further change.

Checked and found sound: no `try!`, no reachable `fatalError`, every
force-unwrap is a fixed URL or date arithmetic that cannot fail, every screen
in all three roles routes to a real view (no "coming soon" left except a
Planning fallback for iOS 16 and older), and nothing decodes a column that
can be null into a field that cannot be.

**What I could not check.** I do not type passwords, so I cannot sign in and
walk the screens myself — everything above is the app examined from the
outside plus the login screen, which I did drive. The simulator panel is open
in front of you: sign in on it and say so, and I will go through every screen
in that role, one by one, and report what is wrong with each.

---

# Round five — the dates again, and a data audit

## 1. RUN-ME-10 did not take

Your orders still carry the exact two timestamps it was meant to clear, so a
statement in it errored and the whole transaction rolled back. The likeliest
culprit is the line that stands the trigger aside.

**Run `scratchpad/RUN-ME-11-restore-order-dates-take-2.sql`.** It does the
same work as one statement, prints how many rows it fixed, and if it still
cannot move the trigger it stops with a message beginning "STOP —". Send me
that line and I will write a version that does not need it. Paste the whole
file and run it without selecting anything.

## 2. The dashboard is not showing year-to-date

It is showing month to date — the tile says so and the query behind it is
month to date. Every order simply *is* dated this month at the moment: all
535 of them carry this morning's timestamp, which is the same fault as
above. That is also why every order looks like it came from one date and why
the total is the whole 1.2 million. Once RUN-ME-11 is in, September will show
September.

The one widget that is deliberately a year view is "Sale · year comparison",
and it is meant to be. Remove it from Arrange if you would rather not see it.

## 3. Is the data correct? — what I found

Checked across all 535 orders, 356 customers, 1,000 products and 22 payments.

**Sound:** no duplicate invoice numbers, no billed order missing one, no
duplicate customer codes or SKUs, no invoice paid more than it is worth, no
payment allocated to more than it is worth, no negative stock, and every
order line that exists adds up to its stored subtotal.

**Wrong, and fixed by RUN-ME-11:**

- Nine invoices (4031, 3748, 3749, 3810, 3811, 3865, 3866, 4100, 4101) carry
  a VAT amount of zero while their total is the subtotal plus five percent.
  The VAT was charged and never written down, so the tax line on those
  documents reads nil. It is corrected inside the same block, so the fix does
  not re-date them.

**Wrong, and yours to decide:**

- **532 of the 535 billed orders have no line items at all.** The imported
  history carries totals only. That is why Total GP reads AED 0.00, why the
  salesman panel says "0 items", and why an invoice PDF for an old order has
  nothing on it. Nothing can recover those lines but the original
  spreadsheets.
- **A confirmed payment of AED 2,200 from 21 August is not applied to any
  invoice.** That customer's balance is 2,200 higher than it should be.
  Open the payment and allocate it.
- **Two products have no price**: HS-14, and GLT4143 (BRACELET). They will
  bill at zero.
- **Fourteen products are priced below cost** — TPD101 to TPD112 at 2.50
  against a cost of 2.55, HT375 at 2.50 against 2.98, and HT209 at 2.50
  against 3.16.
- Twenty-four orders have no VAT at all and a total equal to the subtotal.
  That looks deliberate (zero-rated), so they were left alone — worth a
  glance.

## 4. Goals are set from the Sales page now

On the web, each row of the Goal leaderboard carries a "Monthly goal" field
for a manager. Blank means the company default. It asks the database for the
changed row back, so a refused save says so instead of pretending.

On the phone the editor already existed — tap a salesman on the Sales tab —
but it was shown to everyone, including a salesman opening their own card,
where the database refused the write and the figure moved on screen and
nowhere else. It is manager-only now, and a refusal is shown.

---

# Round six — deleting an order

**Run `scratchpad/RUN-ME-12-order-trash.sql`** first. It only adds three
columns; it does not touch a single existing row, so nothing gets re-dated.

An order can now be deleted, on the web and on the phone, and deleting it
does the three things that have to happen together:

- **The stock goes back on the shelf** — every line it took off at approval.
- **Any payment applied to it is released** — the money stays recorded
  against the customer as unapplied credit, instead of vanishing with the
  invoice. Without this a customer ends up owing money against an invoice
  that no longer exists.
- **It leaves every total** — sales, gross profit, statements, receivables,
  aging. Nothing counts it any more.

It is not thrown away. It goes to **Trash, in Orders** — the web has a Trash
section at the bottom of the orders list, the phone a trash icon in the
Orders toolbar. From there a manager can:

- **Restore** it to the stage it was deleted from. The stock comes off again
  if that stage had deducted it. Payments are deliberately *not* re-applied:
  they were released when it was deleted and may sit against another invoice
  by now.
- **Delete for good** — lines, history and row. That is the deliberate second
  step for something that should never have been an invoice; a tax series
  should not have holes, which is why the first step keeps the number.

Who can do it: a manager, any order. A salesman, their own — but only while
it is still a draft or pending, because after that it has been through
somebody else's hands. The warehouse does not see the bin.

If RUN-ME-12 has not been run, nothing changes: the lists behave exactly as
before, the Trash is empty, and pressing Delete says which file to run.

## Checks run

- Web: types clean, production build clean.
- iOS: `** BUILD SUCCEEDED **`, installed, launched, no new crash report.

---

# Round seven — the full test pass

I tested both apps against your live Supabase, not against a copy.

## How it was tested

- **Every query the web app makes was actually run.** `lib/queries/*` was
  loaded into Node against the live database and each exported function
  called: 43 of 43 returned. The two that go through server routes
  (`/api/products`, `/api/expenses`) were exercised separately.
- **Every column named in either codebase was checked** against the
  database's own description of itself. Web: nothing unknown. iOS: nothing
  unknown.
- **Every API route was checked for an auth guard.** 44 routes; the only two
  without one are the pre-login username lookup and logout, both correctly so.
- **The web login page was opened**, and an unauthenticated visit to /orders
  was correctly bounced to it.
- **The phone was built, installed, launched** and left running: no crash,
  and it remembered the role picked last time.

## What is working

| | |
|---|---|
| Report stage | approved · delivering · delivered (from `app_settings`) |
| Overdue threshold | 90 days (from `app_settings`) |
| VAT rate | 5% (from `app_settings` / zones) |
| Monthly goal | 100,000 default (from `app_settings`) |
| Orders | 535, none deleted, paging and counts fine |
| Leaderboard | Sajjad 3,869 · Ajnaz 3,601 · Saleem 329 · others nil |
| Sales month to date | AED 7,799.07 |
| Payments | **collected 31,791.61 · remaining 493,600.70 · overdue 734,411.42** |
| Receivables | 533 open invoices across 144 customers |
| Customers / products | 356 / 1,000 — a manager sees cost on all 1,000, nobody else sees any |

The dates are back where they belong and the VAT lines are fixed: no invoice
now disagrees with its own total (nine did this morning).

## What is wrong — and it is serious

**Anyone holding the app's public key can read parts of your database
without logging in at all.** That key is embedded in the web app and the
phone app, so it is public by definition. Tested with nothing but the key:

| Table | What comes back |
|---|---|
| `purchases` | **china_cost, landing_cost, total_cost** |
| `products_safe` | the whole catalogue |
| `order_items_safe` | every order line and its price |
| `payment_orders` | who paid what against which invoice |
| `grv_returns`, `grv_items` | customer returns and their value |
| `order_status_log` | order activity |
| `zones` | VAT configuration |

An anonymous **INSERT into `zones` also succeeded** — a stranger could add
rows. (I made one during the test and deleted it again; `zones` is back to
just "Default".)

Everything else — orders, customers, products, payments, users, expenses,
app_settings — correctly returned nothing.

Two causes. The anonymous role still holds grants on the data API even though
nothing in either app uses it before signing in; and `products_safe` and
`order_items_safe` are views, which run as their owner and so hand out rows
the tables underneath them would refuse. The second one is my own doing —
RUN-ME-7 created `products_safe` without `security_invoker`.

**Run `scratchpad/RUN-ME-13-close-the-public-door.sql`.** It takes the
anonymous role's access away entirely, makes both views obey the reader's own
permissions, and puts row security on the seven tables that had none —
including making `purchases` manager-only like every other cost figure.

It grants nothing new, so it cannot open anything. It can only close things,
which means the one thing to watch for is a screen that goes empty: after
running it, open Products, Orders, Payments and Reports once while signed in.
If anything is blank that should not be, tell me which screen and the one-line
undo is in the file.

## Still open from earlier, unchanged

- 532 of 535 billed orders have no line items — the imported history is
  totals only, so GP reads nil and old invoice PDFs are empty.
- A confirmed payment of AED 2,200 from 21 August is applied to no invoice.
- Two products have no price (HS-14, GLT4143); fourteen are priced below cost.
- The Google service-account key and the Gemini key committed in the iOS
  project still want rotating.

---

# Round eight — one list, and how to deploy

## The public door is shut

Re-tested with nothing but the app's public key: every table now answers
401, and the anonymous insert is refused. Nothing readable, nothing
writable, without signing in.

## Customer detail shows the statement only

The Orders list beside it was the same money in different words. It is gone
on both apps. The statement rows carry the selection now — tap the invoices,
then Collect, and the payment opens with exactly those invoices on it. Select
all and the sort toggle moved across with it.

What went with it: the per-order GP% column, on both apps — and, on the
phone only, the collapsible "paid orders" drawer, which on the web sits
outside that block and is still there. Say the word if you want the drawer
back on the phone, or gone from the web, and the two will match again.

Removing the column also removed a heavy query nobody could see the result
of: opening a customer used to pull up to 200 orders and every line of every
one of them, to work out percentages for a list that no longer exists. It now
reads one order, to name the salesman in the header.

## Pushing to GitHub and deploying

Everything is committed on `main` as "Statement is the one list, and the
door is closed". Open GitHub Desktop, press **Push origin**, and Vercel will
build it.

**Before the first deploy**, set these in Vercel → Settings → Environment
Variables, copying each value from your local `.env.local`:

| Name | Needed for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | everything |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | everything |
| `SUPABASE_SERVICE_ROLE_KEY` | user management, imports, exports |
| `GOOGLE_CREDENTIALS_BASE64` | photo and PDF uploads to Drive |
| `APPLE_MAPS_TEAM_ID`, `APPLE_MAPS_KEY_ID`, `APPLE_MAPS_PRIVATE_KEY_BASE64` | the Planning map |
| `GEMINI_API_KEY` | camera scanning (optional) |

`.env.local` itself is not in the repository and must not be — the service
key in it can impersonate anyone.

Once it is live, put the address into `WEB_APP_URL` in the iOS
`Config.xcconfig`, which is what lets a manager create staff logins from a
phone.

## Making an admin account

`scratchpad/RUN-ME-14-make-an-admin.sql` has it in two steps: create the
login in the Supabase dashboard (Authentication → Users → Add user, with
**Auto Confirm User** on, address `username@fgtbilling.internal`), then run
the file to give it a name and the admin role. The address is not a real
mailbox — the app builds it from the username, which is what people actually
type to sign in.
