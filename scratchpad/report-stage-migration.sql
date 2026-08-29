-- §Global: "Admin can adjust at what point of the order/payment flow orders
-- affect reports." Everything was hardcoded to status = 'delivered'; this
-- column makes the threshold configurable from Settings.
--
-- Valid values: 'approved' | 'delivering' | 'delivered'. Defaults to
-- 'delivered', i.e. exactly the behaviour before this change, so running
-- this migration on its own changes no number anywhere.
alter table public.app_settings
  add column if not exists reports_from_status text not null default 'delivered';

alter table public.app_settings
  drop constraint if exists app_settings_reports_from_status_check;

alter table public.app_settings
  add constraint app_settings_reports_from_status_check
  check (reports_from_status in ('approved', 'delivering', 'delivered'));
