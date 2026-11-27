# Route planner — design (proposal, nothing built yet)

2026-11-27. Owner's request: "a user asks for a route, and based on the data
it gives a route. Not AI. Compatible with Siri — 'Hey Siri, give me a route
for today'." The owner's answers to the first round of questions (same day)
are folded in below and listed in §7.

This builds on the planner both apps already have (More → Planning, decided
2026-09-18 in `docs/DECISIONS.md` → "Route planning"). It does not replace it.
The ranking, the hand-arranged order kept on the device, and "Back to
recommended" all stay as they are. The planner gets four additions:

1. **routes by city**: Sharjah, Dubai, Ajman and so on. The route is picked
   by area, never by where the phone happens to be;
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
| City | `customers.district` (the import sample fills it with `DUBAI`) | the day's area |
| Money owed | the shared aging (`fetchOutstandingInvoices` / phone `InvoiceAging`) | overdue / due tiers |
| Per-customer overdue limit | `customers.overdue_threshold_days` | what counts as overdue |
| Last order | `orders.created_at` | days idle |
| Visits | `route_visits` (arrived / departed) | skip shops already visited today |
| **Shop location** | **missing — see §4** | distance between stops |

**The planner never uses anyone's current position.** The device-location log
(admins only) is not read at all.

`district` is matched without regard to case or spaces ("Sharjah" =
"SHARJAH "). The live values could not be checked from here. If some
customers carry a neighbourhood ("Deira", "Al Qusais") instead of a city, a
short fixed list in each app maps it to its city. The same list is in both
apps and covered by the shared tests.

## 2. The rules — one pure function per app

```
planRoute(input) -> Route
  input: customers, invoices (aging), lastOrderAt per customer,
         visitsToday, removedToday, options { city? }
  output: city, ordered stops [{ customer, tier, reason, legKm }], totals
```

### Step 1 — Candidates
Active customers assigned to **the person asking, and only them.** Nobody
asks for, or hears, another salesman's route. An admin uses the door they
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
| 5 Normal | everything else | goes on the route only when it is on the way (≤ 50 km) |

**New tie-break: customer code.** Two shops with equal keys always come out in
the same order on both apps, which "same data, same route" needs.

### Step 3 — Pick the city, then fill the route
- **The city.** If the person names one ("route for Sharjah"), that is the
  city. If not, each candidate gets a weight from its tier (overdue 8, due 4,
  quiet 2, idle 1, normal 0). The weights are added up per city, and the
  highest total is today's city. Ties go to the city holding the
  top-ranked shop.
- **The city's shops.** Every candidate in that city, in rank order, with
  **no limit on the number of stops.** When the shops are close together, a
  route of about 10–12 stops is expected. If there are more, they all
  appear, in order.
- **Nearby shops from other cities.** A shop in another city is added when it
  is within **50 km** of a shop already on the route. That is how a
  Sharjah route picks up the Ajman shop just over the border.
- **The whole route stays within 200 km.** No two stops are more than 200 km
  apart. A shop that would break that is left for its own city's day,
  however high it ranks. Overdue money elsewhere raises that city's weight,
  so the city comes up on a later day.

The weights, 50 km and 200 km are constants in one place in each app, not
settings.

### Step 4 — Order the stops
- **The route starts at the highest-ranked shop on it**, not at the phone's
  position. From there, the next stop is always the nearest remaining one.
  A 2-opt pass then removes crossings; 2-opt is a textbook method that needs
  no library.
- **Collection stops (tiers 1–2) come before the others**, as decided on
  2026-09-18.
- Distances are straight lines between saved shop locations × 1.3 as a road
  allowance. That makes the route **instant and offline**. Siri cannot wait
  on geocoding a dozen addresses.
- "Start driving" hands stop 1 to Apple Maps. Maps works out how to get
  there from wherever the person is; the app does not.
- The web's Apple Maps travel-time ordering (`/api/planning/directions`)
  stays a button ("Optimise with live traffic") on the Planning screen.
  Apple charges one call per ten stops, so it keeps its cap of 20 stops even
  though the route has none. Siri never calls it.
- Shops with no saved location go at the end of their group, marked "no
  location saved".

### Step 5 — The answer
- An ordered list of stops. Each stop shows its reason ("Overdue AED
  4,200 · 94 days" in the app), with the city and the total to collect.
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
> "Hey Siri, today's route in FGT Billing" — or "…route for Sharjah in FGT
> Billing"
>
> Siri: "12 stops in Sharjah, 3 of them to collect. First stop: Al Noor
> Trading." The card lists the stops with **Open route** and **Start
> driving** buttons.

**Siri never says an amount, and the card shows none.** The phone may be on
speaker, and the Siri card can appear over the lock screen. It gives counts
("3 to collect") and shop names only. Amounts are on the Planning screen,
behind the app's sign-in, as they are today.

### How it is built
- A new `PlanTodayRouteIntent: AppIntent` in `Billing/BillingAppIntents.swift`,
  next to the two order intents. It runs **without opening the app**
  (`openAppWhenRun = false`), reads the cached data, calls `planRoute`, and
  returns:
  - a spoken `IntentDialog`;
  - a `ShowsSnippetView` card listing the stops;
  - **Open route**, which opens Planning with this route;
  - **Start driving**, which opens Apple Maps to stop 1.
- One optional parameter: `city`, offered from the cities in the person's own
  customer list. There is **no salesman parameter**: everyone gets their
  own route.
- Phrases registered in `BillingAppShortcuts`:
  "Today's route in \(.applicationName)", "Give me a route for today in
  \(.applicationName)", "Plan my route in \(.applicationName)", and "Route
  for \(\.$city) in \(.applicationName)".
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
place or to nowhere. The 50 km and 200 km rules need real distances, so they
need real locations.

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

Three ways a shop could get its location, best first (owner to choose, §7):
1. **Pinned.** "Save this shop's location here" on the customer screen,
   pressed while standing in the shop. It is never overwritten
   automatically.
2. **From a visit.** When a salesman taps *Arrived* (`route_visits`) at a
   shop with no location, the phone's position at that moment is saved as
   the shop's location. This records where the shop is. It plays no part in
   planning anyone's route.
3. **From the address.** A one-off backfill job on the queue (rule 8) runs
   every address through the Apple Maps geocoder the web already uses. It
   is a last resort and never overwrites 1 or 2.

## 5. What does not change
- No `routes` table. Today's route stays one person's working order, kept on
  their device (2026-09-18).
- No AI, no learning, no external service beyond the Apple Maps
  account the web already has.
- The device-location log stays admin-only and is not read by the planner.
- Siri and its card show no money amounts.

## 6. Build order (each step is its own small task)
1. `planRoute` on the web + shared fixtures + tests. Planning's
   "Recommended" uses it. *(web)*
2. The same in Swift, passing the same fixtures. *(iOS/Mac)*
3. RUN-ME-49 shop locations, and whichever ways of filling them the owner
   picks. *(both)*
4. `PlanTodayRouteIntent` + phrases + snippet card. *(iOS/Mac)*
5. The address backfill job, if chosen. *(web queue)*

## 7. Owner decisions

Answered 2026-11-27:
1. **Stops per day:** no limit. About 10–12 is expected when shops are near.
2. **Distance:** shops within **50 km** count as nearby. The whole route
   stays within **200 km**. (The first draft's 15 km was too small.)
3. **Money aloud:** no. Siri gives counts and names only.
4. **Other people's routes:** no. Everyone sees, and asks Siri for, their own
   route only.
5. **Starting point:** by city (Sharjah, Dubai, Ajman…), not by where the
   device is now.

Still open:
6. **Shop locations:** pin, save on arrival, and address backfill — all
   three, or which?
7. **Siri wording:** set up the "Give me a route for today" shortcut on each
   phone, or rename the app for Siri?
8. **Recently visited:** should a shop visited in the last few days drop down
   the list unless it is overdue? Without this, the same city can win every
   day until its shops are cleared.
9. **The manager's salesman picker on the Planning screen.** It exists today
   on both apps and lets a manager view any salesman's recommended route.
   Answer 4 could mean it should go. It stays unless the owner says remove
   it (rule 1).
