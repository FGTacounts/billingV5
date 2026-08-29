-- Famlist Billing — gapless, race-free invoice numbering.
--
-- WHAT THIS FIXES
-- The number was assigned in JavaScript at approval: read every existing
-- invoice number, take the highest in JS, write +1. Two managers approving
-- at the same moment both read the same highest number and both write it.
-- Duplicate invoice numbers are an audit finding in most jurisdictions.
--
-- WHY NOT A POSTGRES SEQUENCE
-- A sequence is the usual answer to that race, and it was my first draft.
-- But nextval() does not roll back — if a number is taken and the
-- transaction then fails, that number is gone and the series has a hole.
-- You have said you do not want gaps, so a sequence is the wrong tool here.
--
-- Instead this takes a transaction-scoped advisory lock, reads the current
-- highest number, and adds one. Two callers cannot interleave, and a failed
-- transaction leaves the counter exactly where it was, because the counter
-- IS the data. That is gapless and race-free.
--
-- The trade-off is that invoice numbering serialises: two approvals happening
-- at the exact same instant queue rather than run in parallel. At your volume
-- that costs microseconds and is the correct trade for a tax document series.
--
-- WHEN THE NUMBER IS ASSIGNED
-- At approval, when the invoice is actually issued — not at order creation.
-- Assigning at creation would mean a cancelled order consumed a number and
-- left a gap, which is the thing you are avoiding.
--
-- Safe to re-run.

create or replace function public.assign_invoice_number(order_id_param uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing text;
  start_setting bigint;
  next_number bigint;
begin
  -- Idempotent: an order that already has a number keeps it. The app calls
  -- this on approval, and approval can legitimately be retried.
  select o.invoice_number into existing
    from public.orders o
   where o.id = order_id_param
     for update;

  if not found then
    raise exception 'Order % does not exist', order_id_param;
  end if;

  if existing is not null and existing <> '' then
    return existing;
  end if;

  -- One arbitrary but fixed key, so every caller assigning an invoice number
  -- waits on the same lock. Released automatically at end of transaction,
  -- including on rollback.
  perform pg_advisory_xact_lock(hashtext('famlist_invoice_number'));

  select coalesce(invoice_start_number, 4300) into start_setting
    from public.app_settings
   order by id
   limit 1;

  -- Highest number actually issued, or one below the configured start if
  -- nothing has been issued yet. Cast explicitly: invoice_number is text, and
  -- a text sort would rank '9999' above '10000'.
  select greatest(
           coalesce(max((invoice_number)::bigint), 0),
           coalesce(start_setting, 4300) - 1
         )
    into next_number
    from public.orders
   where invoice_number ~ '^[0-9]+$';

  next_number := next_number + 1;

  update public.orders
     set invoice_number = next_number::text
   where id = order_id_param;

  return next_number::text;
end $$;

grant execute on function public.assign_invoice_number(uuid) to authenticated, service_role;

-- Two orders must never share a number. This is what makes a duplicate
-- impossible rather than merely unlikely: if any code path ever regresses to
-- assigning numbers itself, the database refuses the write.
-- Verified before writing this: there are no duplicates today, so it applies
-- cleanly.
create unique index if not exists orders_invoice_number_unique
  on public.orders (invoice_number)
  where invoice_number is not null;

-- If an earlier version of this file created a sequence, it is unused now.
-- Left in place rather than dropped, in case anything else came to depend on
-- it; it does no harm. To remove it:
--   drop sequence if exists public.invoice_number_seq;
