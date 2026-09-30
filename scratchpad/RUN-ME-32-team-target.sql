-- ============================================================
-- FGT Billing — one monthly target for the whole team, kept
-- apart from each salesman's default goal.
--
-- Owner, 2026-09-30, on the Sales page's "% to target": "The
-- percentage to target is wrong. it should be adjustable too".
--
-- Until now there was no team target of its own:
--
--   • The web measured the team against the salesmen's goals
--     added up (three salesmen on 100,000 = 300,000), with
--     nothing to adjust.
--
--   • The phone let the manager type a team target on the
--     Reports screen, and saved it into
--     app_settings.default_monthly_target. That column is the
--     goal every salesman without one of their own is given. So
--     typing a team target of 100,000 on the phone gave each
--     salesman a goal of 100,000 on the web, and the two apps
--     showed the same month as ~72% on the phone and 24% on the
--     web.
--
-- What this adds:
--
--   • app_settings.team_monthly_target — the team's monthly sales
--     target in AED, set by a manager on either app. Null means
--     "not set", and both apps then fall back to the salesmen's
--     goals added up, which is exactly what the web shows today.
--     Nothing is copied into it: default_monthly_target may hold
--     either the phone's team figure or a real per-salesman
--     default, and there is no telling which. Set it once from
--     the Sales page or the phone.
--
-- AED with two decimals, not minor units, to match
-- default_monthly_target and users.monthly_target beside it.
--
-- No policy change: app_settings already has RLS with FORCE and
-- managers can already update it (it is where the phone has been
-- writing the team figure all along). Nothing new is readable
-- without signing in.
--
-- Safe to re-run.
-- ============================================================

alter table public.app_settings
  add column if not exists team_monthly_target numeric(14, 2);

comment on column public.app_settings.team_monthly_target is
  'The whole team''s monthly sales target in AED. Null = the salesmen''s own goals added up.';

-- Plain statements, no DO block: dropped and re-added so it is
-- safe to run twice.
alter table public.app_settings
  drop constraint if exists app_settings_team_target_nonneg;

alter table public.app_settings
  add constraint app_settings_team_target_nonneg
  check (team_monthly_target is null or team_monthly_target >= 0);

-- PostgREST caches the column list; without this both apps keep
-- being told the new column does not exist for a few minutes.
notify pgrst, 'reload schema';

-- Should return one row: team_monthly_target | numeric
select column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name = 'app_settings'
  and column_name = 'team_monthly_target';
