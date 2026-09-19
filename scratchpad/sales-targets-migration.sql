-- Famlist Billing — per-salesman monthly sales targets.
--
-- THE PROBLEM
-- Every goal figure in the app came from a constant in the code:
--
--     export const DEFAULT_MONTHLY_TARGET = 100000;
--
-- It is used in a dozen places across the Dashboard, the Sales page and the
-- salesman drill-down, which means every salesman is shown the same AED
-- 100,000 goal and every "% to goal" is measured against it. Your own
-- mockup disagrees — it shows Ajnaz, Shamseer, Saleem and Sajjad on 100,000
-- but Bilal on 10,000 — and there was nowhere in the database to store that
-- difference. This adds it.
--
-- A null target on a user means "use the company default", so you only have
-- to set the people who differ.
--
-- Safe to re-run.

alter table public.users
  add column if not exists monthly_target numeric(14, 2);

comment on column public.users.monthly_target is
  'This salesman''s monthly sales goal in AED. Null = fall back to app_settings.default_monthly_target.';

alter table public.app_settings
  add column if not exists default_monthly_target numeric(14, 2) not null default 100000;

comment on column public.app_settings.default_monthly_target is
  'Company-wide monthly sales goal, used for any salesman with no target of their own.';

-- A negative goal is meaningless and would invert every percentage that
-- reads from it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'users_monthly_target_nonneg') then
    alter table public.users
      add constraint users_monthly_target_nonneg
      check (monthly_target is null or monthly_target >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'app_settings_default_target_nonneg') then
    alter table public.app_settings
      add constraint app_settings_default_target_nonneg
      check (default_monthly_target >= 0);
  end if;
end $$;
