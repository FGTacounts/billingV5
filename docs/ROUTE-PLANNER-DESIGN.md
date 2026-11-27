# Route planner — design (proposal, nothing built yet)

2026-11-27. Owner's request: "a user asks for a route, and based on the data
it gives a route. Not AI. Compatible with Siri — 'Hey Siri, give me a route
for today'."

This builds on the planner both apps already have (More → Planning, decided
2026-09-18 in `docs/DECISIONS.md` → "Route planning"). It does not replace it.
The ranking, the hand-arranged order kept on the device, and "Back to
recommended" all stay as they are. The planner gets four additions:

1. a **stop-picking step**, so a day's route stays in one area instead of
   crossing the country;
2. **saved shop locations**, so a route can be built in under a second
   without geocoding addresses;
3. **today's visits taken into account**, so a shop already visited drops
   off the route;
4. a **Siri / Shortcuts entry point** on iPhone, iPad and Mac.

Every step is a fixed rule over data the business already records. The same
inputs always give the same route, and every stop shows the reason it was
chosen.

---

## 1. What the planner reads (all of it exists today)

| Data | Table / source | Used for |
|---|---|---|
| Who the customer belongs to | `customers.salesman_id`, `is_active` | whose route a shop is on |
| Area | `customers.district`, `address` | grouping, the city filter |
| Money owed | the shared aging (`fetchOutstandingInvoices` / phone `InvoiceAging`) | overdue / due tiers |
| Per-customer overdue limit | `customers.overdue_threshold_days` | what counts as overdue |
| Last order | `orders.created_at` | days idle |
| Visits | `route_visits` (arrived / departed) | skip shops already visited today |
| Where the phone is now | Core Location on the device, or the latest `location_points` row | starting point |
| **Shop location** | **missing — see §4** | distance between stops |

Nothing new is collected about people. The only new column is the shop's
location.

## 2. The rules — one pure function per app

```
planRoute(input) -> Route
  input: customers, invoices (aging), lastOrderAt per customer,
         visitsToday, removedToday, start point, options { city?, maxStops }
  output: ordered stops [{ customer, tier, reason, legKm }], area, totals
```

### Step 1 — Candidates
Active customers assigned to the person asking. A manager asking says whose
route ("for Ahmed"); otherwise it is their own. An admin uses the door they
signed in through (2026-11-27). The candidates exclude:
- shops with a visit logged today (`route_visits.arrived_at` on today's
  Dubai date);
- shops removed by hand from today's route (already remembered on the
  device).

### Step 2 — Rank (unchanged from today)
| Tier | Rule | Order inside the tier |
|---|---|---|
| 1 Overdue | any invoice older than that customer's threshold | largest overdue first |
| 2 Due | owes anything | largest balance first |
| 3 Good customer gone quiet | no order for 30–59 days | longest idle first |
| 4 Idle | 60+ days, or never ordered | longest idle first |
| 5 Normal | everything else | not on the route unless there is room |

**New tie-break: customer code.** Two shops with equal keys always come out in
the same order on both apps, which "same data, same route" needs.

### Step 3 — Pick the day's area and stops (new)
The current list takes the top 20–25 shops from anywhere. A salesman
covering Dubai and Al Ain can be sent across the country twice in one day.
- Each candidate gets a **weight** from its tier: overdue 8, due 4, quiet 2,
  idle 1, normal 0.
- Weights are added up per **district**. The district with the highest total
  is **today's area**. Ties are broken by the district holding the
  top-ranked shop.
- Fill the route **in rank order**, first from today's area, then from shops
  within **15 km** of it, until `maxStops` (default 12) is reached.
- **Overdue shops are never left out because of distance.** If an overdue
  shop is outside the area, it still goes on the route, marked "outside
  today's area".
- Saying a city ("route for Sharjah") skips the area choice. That is the
  existing city filter.

The weights, the 15 km and the 12 stops are starting values for the owner to
confirm (§7). They are constants in one place in each app, not settings.

### Step 4 — Order the stops (today's rule, made faster)
- Start from where the phone is now. If there is no fix, use the first stop.
- **Collection stops (tiers 1–2) come before the others**, as decided on
  2026-09-18. Nearest-neighbour ordering runs inside each group, then a
  2-opt pass removes crossings. 2-opt is a textbook method that needs no
  library.
- Distances are straight lines between saved shop locations × 1.3 as a road
  allowance. That makes the route **instant and offline**. Siri cannot wait
  on geocoding twelve addresses.
- The web's Apple Maps travel-time ordering (`/api/planning/directions`)
  stays for when a person presses "Optimise with live traffic". Siri never
  calls it.
- Shops with no location go at the end of their group, marked "no location
  saved".

### Step 5 — The answer
- An ordered list of stops. Each stop shows its reason ("Overdue AED
  4,200 · 94 days"), with the area and the total to collect.
- An estimated drive: road km ÷ 35 km/h, plus 15 min a stop. It is labelled
  an estimate.
- If the person has arranged today's route by hand, **their order wins**.
  Siri reads that route back instead of a new one, as the app already does.

### Where the code lives
- Web: `lib/routePlan.ts` (pure, no Supabase calls), fed by what
  `fetchRoutePriorities` already loads.
- iOS / Mac: `Billing/RoutePlanner.swift` (pure), fed by AppDataManager's
  cached customers and invoices. It adds no new sync and no timer, so it
  costs no egress. The database is already over the Free egress cap; no
  sync timers and no whole-table reloads.
- **One set of test fixtures** (`tests/fixtures/route-plan/*.json`) that both
  apps' tests run through, so the two implementations cannot drift. They
  already drifted once (the idle-tier bug, 2026-09-18).
- Rejected: a Postgres `plan_route()` function. The aging logic lives in the
  apps, and a third copy in SQL would be the one that drifts. It would also
  add a network round trip to every Siri request.

## 3. Siri

### What the person says and hears
> "Hey Siri, today's route in FGT Billing"
>
> Siri: "12 stops in Deira. Start with Al Noor Trading, 3 overdue to
> collect." The card shows the first five stops, with **Open route** and
> **Start driving** buttons.

### How it is built
- A new `PlanTodayRouteIntent: AppIntent` in `Billing/BillingAppIntents.swift`,
  next to the two order intents. It runs **without opening the app**
  (`openAppWhenRun = false`), reads the cached data, calls `planRoute`, and
  returns:
  - a spoken `IntentDialog`;
  - a `ShowsSnippetView` card listing the first stops;
  - **Open route**, which opens Planning with this route;
  - **Start driving**, which opens Apple Maps to stop 1.
- An optional `city` parameter: "today's route for Sharjah in FGT Billing".
  An optional `salesman` parameter for managers. If the person is not a
  manager, Siri does not ask.
- Phrases registered in `BillingAppShortcuts`:
  "Today's route in \(.applicationName)", "Give me a route for today in
  \(.applicationName)", "Plan my route in \(.applicationName)".
- If nobody is signed in: "Open FGT Billing and sign in first." The intent
  never caches a session of its own.
- The same intent appears in Spotlight, the Shortcuts app, the Action button,
  and Siri on the Mac (Catalyst parity is a standing rule).

### The one Apple limit to know about
**Apple only accepts built-in phrases that contain the app's name.**
"Hey Siri, give me a route for today" *on its own* cannot be registered by
any app. Siri needs "…in FGT Billing". There are two ways to make the exact
words work:
1. The owner or a salesman opens Shortcuts → **+** → adds "Today's Route"
   (FGT Billing) and names the shortcut **"Give me a route for today"**.
   Siri then answers to exactly that sentence. It takes thirty seconds and
   is set once per phone.
2. Or the app gets a shorter display name for Siri (for example "FGT"), so
   the phrase becomes "today's route in FGT". That changes the app's name
   under its icon, so it is the owner's call.

## 4. Shop locations — the one database change

Today **no customer has a stored location**. The web geocodes addresses on
every route through Apple Maps, and the phone geocodes the top 12 on the
device. UAE addresses ("Shop 4, near Lulu, Deira") often geocode to the wrong
place or to nowhere. That is why the phone caps the list at 12 and why
routes jump around.

Proposed RUN-ME-49:

```sql
alter table public.customers
  add column latitude         double precision,
  add column longitude        double precision,
  add column location_source  text check (location_source in ('pinned','visit','address')),
  add column location_set_at  timestamptz;
```

The existing RLS and FORCE on `customers` already cover these columns. They
add no new table and no new policy, and `test:tenancy` still applies.

Three ways a shop gets its location, best first:
1. **Pinned.** "Save this shop's location here" on the customer screen,
   pressed while standing in the shop. It is never overwritten
   automatically.
2. **From a visit.** When a salesman taps *Arrived* (`route_visits`) at a
   shop with no location, the phone's position at that moment is saved as
   `visit`. Within a few weeks of normal work most shops will have one, with
   no extra effort from anyone.
3. **From the address.** A one-off backfill job on the queue (rule 8) runs
   every address through the Apple Maps geocoder the web already uses. It
   is a last resort and never overwrites 1 or 2.

## 5. What does not change
- No `routes` table. Today's route stays one person's working order, kept on
  their device (2026-09-18).
- No AI, no learning, no external service beyond the Apple Maps
  account the web already has.
- The device-location log stays admin-only. The planner uses only *this*
  phone's current position, never another person's.
- Nothing is spoken aloud that the person could not already see on their
  Planning screen.

## 6. Build order (each step is its own small task)
1. `planRoute` on the web + shared fixtures + tests. Planning's
   "Recommended" uses it. *(web)*
2. The same in Swift, passing the same fixtures. *(iOS/Mac)*
3. RUN-ME-49 shop locations, the Pin button, and saving the location on
   Arrived. *(both)*
4. `PlanTodayRouteIntent` + phrases + snippet card. *(iOS/Mac)*
5. The address backfill job. *(web queue, optional)*

## 7. Owner decisions needed before building
1. **Stops per day:** 12 as the default?
2. **One area per day:** keep the route inside one district (+15 km), with
   overdue shops as the only exception?
3. **Shop locations:** pin + save on arrival + address backfill, all three?
4. **Siri wording:** set up the "Give me a route for today" shortcut on each
   phone, or rename the app for Siri?
5. **Money spoken aloud:** should Siri say amounts ("AED 4,200 overdue"), or
   only counts ("3 to collect")? The phone may be on speaker in a shop.
6. **Managers:** should "route for Ahmed" work for managers, or only
   salesmen asking for their own?
7. **Recently visited:** besides today's visits, should a shop visited in the
   last 3 days drop down the list unless it is overdue?
