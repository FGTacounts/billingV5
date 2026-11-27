-- ============================================================
-- FGT Billing — record salesmen's routes from 5 am to midnight.
--
-- RUN-ME-46 set the working window to 5 am – 12 noon. The owner
-- meant 5 am to 12 am (midnight) (2026-11-27). This changes only
-- the window; every device picks it up the next time the app
-- opens, with no app update.
--
-- Paste into Supabase -> SQL Editor -> Run (address bar must say
-- isdeheipdfmwzmmnnidr). Safe to run more than once.
-- ============================================================

create or replace function public.location_tracking_hours()
returns table (start_hour int, end_hour int)
language sql
stable
security invoker
set search_path = public
as $$
  -- 24 = up to midnight.
  select 5, 24;
$$;

revoke all on function public.location_tracking_hours() from public, anon;
grant execute on function public.location_tracking_hours() to authenticated;

-- Check it worked: should say 5 and 24.
select * from public.location_tracking_hours();
