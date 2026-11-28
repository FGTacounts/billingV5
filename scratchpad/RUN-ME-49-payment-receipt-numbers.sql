-- ============================================================
-- FGT Billing — a receipt number on every payment.
--
-- Owner, 2026-11-28:
--   "in the payments collection page, Make option for receipt
--    number for each of the receipts."
--   Asked which kind: "Typed in (receipt book)".
--
-- The collector types the number printed on the paper receipt
-- they hand the customer. It is optional — a payment without a
-- receipt book page still saves — and it is plain text, because
-- receipt books are printed with prefixes and leading zeros
-- ("A-00412") that a number column would lose.
--
-- Nothing is numbered by the database and nothing is unique: two
-- salesmen can carry books that both start at 001. The column
-- sits on the existing payments table, so its RLS (enabled and
-- forced) already covers it; no policy changes.
--
-- Both apps work before this is run — they leave the field out
-- and save the rest — but the number is only kept once it has.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says isdeheipdfmwzmmnnidr first.
-- Safe to run more than once.
-- ============================================================

alter table public.payments
  add column if not exists receipt_number text;

-- A blank typed in the app is saved as null; this keeps a stray
-- space or an empty string from looking like a receipt.
alter table public.payments
  drop constraint if exists payments_receipt_number_not_blank;
alter table public.payments
  add constraint payments_receipt_number_not_blank
  check (receipt_number is null or length(btrim(receipt_number)) > 0);

comment on column public.payments.receipt_number is
  'Number on the paper receipt the collector handed over, as typed. Optional, not unique.';

-- Make the new column visible to the apps straight away.
notify pgrst, 'reload schema';

-- Check: one row, receipt_number / text / YES.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'payments' and column_name = 'receipt_number';
