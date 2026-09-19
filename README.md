# FGT Billing — Web

Internal sales/warehouse tool for Famlist General Trading LLC, spanning all the company's brands. Next.js 14 (App Router) on Vercel, backed by **Supabase (Postgres + Auth + Realtime)**. Three roles — Salesman, Manager, Warehouse — sharing the same backend as the companion iOS app, so state stays live across both.

This is a ground-up rebuild off the old Google Sheets backend (see git history for `lib/sheets.ts` etc. if you need the old version) — the Sheets backend took ~30s to respond under concurrent Manager use, which is the specific failure mode this rebuild eliminates via Postgres + Realtime + windowed loading.

---

## Local setup

Requires Node.js 18.18+.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev                  # http://localhost:3000
```

### Environment variables

See `.env.example` for the full list and explanations. In short:

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public — RLS is the real access control, safe to ship to the browser |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only, powers Manager user-management. Never `NEXT_PUBLIC_*` |
| `GOOGLE_CREDENTIALS_BASE64` (or the email/key pair) | Server-only, Drive access for product photos, cheque/delivery photos, and invoice PDFs |

---

## Architecture

- **Auth**: username + password via Supabase Auth (username maps to a synthetic `@fgtbilling.internal` email internally — the UI never shows "email"). `middleware.ts` + `@supabase/ssr` handle session refresh and role-based routing.
- **Data access**: `lib/queries/*.ts` are the typed query layer. Salesman/Warehouse sessions always read products/order line items through the `products_safe`/`order_items_safe` Postgres views, which RLS-null `cost`/`stock_on_hand`/`unit_cost` for non-Manager roles — enforced server-side, not hidden client-side.
- **Realtime**: `lib/realtime/useRealtimeTable.ts` subscribes to Postgres changes on `orders`, `order_items`, `payments`, `notifications` so a Manager approving on web shows up instantly in the iOS Warehouse queue, and vice versa.
- **Design tokens**: `tailwind.config.ts` + CSS variables in `app/globals.css`, light/dark via `prefers-color-scheme` and a manual `data-theme` override (Settings → Appearance).
- **PDF/Excel**: `lib/pdf/invoice.ts` (pdf-lib) generates Performa (Salesman/Warehouse) and Tax (Manager) invoices; `app/api/export/excel` (exceljs) is Manager-only per the permission matrix.
- **Google Drive**: `lib/google-drive.ts`, server-only. Folder IDs come from the `app_settings` table, not env vars.

## Known schema gaps

There's no SQL/dashboard access available in this environment — the live schema was reverse-engineered via PostgREST column probing plus the reference `.xlsx` report layouts. A few things flagged rather than guessed at:

- **No stored order total/VAT/discount columns** — `lib/money.ts` computes subtotal/VAT(5%)/GP from `order_items` on every read instead. A whole-order discount (separate from per-customer `customer_discounts`) has nowhere to persist.
- **No `address` column** anywhere (orders or customers) — the decluttering rule in the design spec just never renders it, since there's no data.
- **`users`/`customers`/`product_categories` currently allow unauthenticated SELECT** via the anon key — recommend tightening RLS (see the plan doc from the initial build for the exact SQL) since usernames/emails/phone numbers are otherwise scrapeable pre-login.

Run `npx supabase gen types typescript --project-id <ref>` against the project and diff it against `lib/types/db.ts` to close any remaining gap in what was hand-probed.

---

## Deploy to Vercel

1. Push to a GitHub repo, import into Vercel (Next.js auto-detected).
2. Add every variable from `.env.example` under Settings → Environment Variables.
3. Deploy.
