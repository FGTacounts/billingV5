# Web → Mac app: what is still owed

Owner, 2026-10-12: "Make everything in the web app appear in the macOS
catalyst app. it should function same. Always remember to do this."

The Mac app is the iPhone app's `Billing` target built for Mac Catalyst, so
every item below is a change to the Swift app and reaches iPhone and iPad
too. The list comes from reading both apps side by side on 2026-10-12, one
screen at a time. Tick an item when it ships and say so in DECISIONS.md. An
item marked (was deliberate) was logged in DECISIONS.md as left for the owner
or "web only"; the instruction above now settles those.

Sizes: S an hour or two, M about a day, L several days.

## 1. Figures that differ (do these first)

- [x] Gross profit and GP %: per order, net of the order discount, uncosted
      sale left out, "—" when nothing is costed. Dashboard, Sales, salesman
      drill-down. (2026-10-12)
- [x] An order discounted on the web was approved at full price on the Mac,
      and any Mac save rewrote its totals from the lines. The discount is now
      read and billed with. (2026-10-12)
- [ ] Set or change the order discount from the Mac (read-only today). S
- [ ] Manager edits to an approved order do not move stock (the web goes
      through `manager_edit_order`). M–L
- [x] Order rows show the stored billed total. (2026-10-12)
- [ ] Inside an order the totals still work at a flat 5% under a "VAT (5%)"
      label; the stored figures use the zone's rate. S
- [x] Orders: Received and Balance come from confirmed payments. (2026-10-12)
- [x] Dashboard Profit is GP less the month's expenses; the Mac banner
      shows it and the month's order count. (2026-10-12)
- [x] Dashboard pipeline counts every open order by stage. (2026-10-12)
- [x] Dashboard expense tile bounded by local calendar dates. (2026-10-12)
- [ ] Dashboard payments chart: different segments, unpaged read. S–M
- [x] Reports › Sales is month to date, before VAT. (2026-10-12)
- [x] Reports › Balance sheet sums `subtotal`; CSV download. (2026-10-12)
- [x] Reports › Aging and Statement summary take goods returns off.
      (2026-10-12)
- [ ] Reports › Aging and Statement summary list inactive customers by name;
      the web shows "—" or leaves them out. S
- [ ] Products table: Sale, GP, SHD (30× too small) and Sold are worked out
      differently; VAC/SAD reads stop at 1,000 rows. M
- [ ] Invoice PDF: line discount, VAT at the zone's rate, customer VAT
      number, salesman's phone, payment terms, logo, A4. M via the web's
      `/api/invoice-pdf`
- [x] Invoices list: billed orders, billing date, four sorts. (2026-10-12)
- [x] Payment discount is an AED amount on top, for manager and admin.
      (2026-10-12)
- [ ] Collecting from a customer's sheet uses a second payment form that
      fills from the invoice total, not the balance. M
- [x] Expenses: type and category as stored; category saved as typed; a new
      expense dated by the local day. (2026-10-12)
- [ ] Planning: overdue after 30 days where the web says 90 when a customer
      has no threshold; "normal" customers dropped; list capped at 25. S–M
- [ ] Lines added to an order take list price, not the customer's price, and
      salesman/warehouse lines store no cost. M, via `/api/orders/create`
      and `/api/orders/add-item`

## 2. Whole things the web has and the Mac does not

- [ ] Month chooser on Dashboard and Sales (was deliberate). L
- [ ] Orders: Adjust View with GP (was deliberate). L
- [ ] Orders: "This month" list with GP and GP % (was deliberate). M
- [ ] Orders: stage values and "Potential total" (was deliberate). S
- [ ] Orders: sort on every list; manager search across all tabs. S
- [ ] Orders: bulk "Import orders"; Export Excel. M
- [ ] Orders: server drafts (the Mac's are kept on the device). M
- [ ] Order detail: line GP and price-from-margin, subtotal override, "As
      arranged" line order, PDF button, reopen a packed order, confirm on
      Reject and Undo approval. M
- [ ] Warehouse on the Mac: Waiting / Picking / Packed tabs (one flat list
      today, and no way to reach a packed order). S
- [ ] Picking: visible buttons for Edit quantity, Adjust stock, Remove (right
      click only today); short pick writes the picked quantity. M
- [ ] Salesman orders: search, sort, delete to Trash, own deleted orders. S–M
- [ ] Customers: summary card (was deliberate). M
- [ ] Customers: Adjust View (was deliberate). M
- [ ] Customers: exact amounts instead of "12K"; "Payments needed" filter;
      row statement download; Overdue pill; "No data". S–M
- [ ] Customers: Add/Suggest for salesman and warehouse; delete; code,
      country and threshold fields as on the web. M
- [ ] Payments: cheque photo upload and scan from a file; open a cheque
      photo from the table; in-row Confirm and cheque status; cash/cheque
      switch when editing; paging; export. M
- [ ] Products for the salesman: the catalogue (photo grid only today). M
- [ ] Products: Gallery view, Drive photo browser and Select → Start order
      on the wide layout; photo upload in add/edit. M–L
- [ ] Products: edit saves SKU and Active; barcode search; low-stock filter;
      custom column presets; "keep" option on import. S each
- [ ] Products: Scan invoice button and an editable review. M
- [x] Expenses: summary card. (2026-10-12)
- [x] Expenses: Notes field; CSV export with type, category and notes.
      (2026-10-12)
- [x] Expenses lists every date; future dates allowed. (2026-10-12)
- [ ] Expenses: the web accepts a zero amount; the Mac asks for one above
      zero. Not asked. S
- [ ] Sales: goal table with every salesman, sort, bonus and special offer;
      team target; trend with "today vs same day"; custom date range;
      trailing twelve months. M
- [ ] Salesman drill-down: 7 d / 30 d / MTD / YTD, previous period, prorated
      goal, billed orders by billing date. M
- [ ] Salesman dashboard: Pending / Received / Overdue, payments chart,
      range picker, enlarge, tiles that open their page, own arrangement. M
- [ ] Manager dashboard: average-sale chart follows its range; previous
      period line; Category / Product toggle; arrange gallery; full amounts
      instead of "82K". M
- [ ] Reports: the sales board above the tabs (the Swift one exists but is
      not shown anywhere). M
- [ ] Settings: editable data sheet (exists in Swift, not shown anywhere);
      theme light/dark; quick-download format; colourful data; keyboard
      shortcuts; download all customers/products/orders. M
- [ ] Settings: display currency does nothing on the Mac; accent colour
      reaches only some screens. M
- [ ] Preferences do not follow the user between web and Mac (layouts,
      columns, pinned filters, line sort, tab order). M–L
- [ ] Account: edit e-mail; avatar from a file and shown in the sidebar. M
- [ ] Brand logo: manager may upload, reset to default, shown without first
      opening Settings. M
- [ ] Users: delete without a swipe; no role/active change on yourself. S
- [ ] Zones: remove a zone; "make default" clears the old default. S
- [ ] Inbox: Clear all must not delete news; errors shown; a goods-return
      row opens Payments; author on a news row. S
- [ ] Planning: visits saved (`/api/planning/visits`); starting point and
      per-leg distance; hidden until maps are set up. M
- [ ] Offline banner for every role that can queue a change. S
- [ ] Excel import (.xlsx) for customers, products, expenses and order
      lines — the Mac reads text files only. Needs either a server route
      that parses the file or a Swift library (ask first). M–L
- [ ] Every download leaves through a share sheet; a Mac should offer Save.
      Needs a run on the Mac to confirm. S–M

- [x] A deactivated account is refused at sign-in; a session with no profile
      is told so and offered Sign out. (2026-10-12)

- [x] The phone's salesman Request Edit is on approved orders only and is
      always a request. (2026-10-12)

## 3. Mac-only awkwardness

- [ ] Scan with AI, warehouse New order and several toolbars are reachable
      only from the menu bar or a bottom bar. S
- [x] Sidebar: the pin is kept. (2026-10-12)
- [ ] Sidebar: the gear opens Account, not Settings. S
- [x] Login: Return moves on or signs in. (2026-10-12)
- [ ] Remove a widget / a user / a planning stop by swipe only. S
