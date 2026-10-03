-- ============================================================
-- FGT Billing — a new article needs a cost price.
--
-- Owner, 2026-10-03: "Don't allow anybody to add articles without
-- cost. (managers - don't allow and admins - warning)"
-- And, the same day: "block clearing cost".
--
-- The web checks this in its own routes. The phone writes new
-- articles straight into public.products with the signed-in
-- person's session, so the line has to be held here as well, or
-- a manager on the phone walks round it.
--
-- What this adds: a check that runs before every new row in
-- public.products. When the cost is empty or 0 and the person
-- signed in is not an admin, the row is refused with
--
--     A new article needs a cost price.
--
-- The same check runs when an article's cost is changed: a cost
-- above 0 cannot be set back to empty or 0, refused with
--
--     An article's cost price can't be cleared.
--
-- An admin is let through both — the warning an admin gets is the
-- app's job, and the admin may still go ahead.
--
-- Not touched:
--   • Articles that have no cost yet. They are edited as before;
--     only a cost that is there is protected.
--   • Any change that does not touch the cost (stock, price, name…).
--   • The web's server routes, the SQL editor and imports run by
--     the server key. None of them has a signed-in person (no
--     auth.uid()), and the web routes make the same check
--     themselves before they write.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run, with
-- the role selector set to postgres. Safe to run more than once.
-- Uses public.current_user_is_admin() from RUN-ME-17.
--
-- To undo:
--   drop trigger if exists products_need_a_cost on public.products;
--   drop function if exists public.products_need_a_cost();
-- ============================================================

create or replace function public.products_need_a_cost()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.cost is null or new.cost <= 0)
     and auth.uid() is not null
     and not public.current_user_is_admin() then
    if tg_op = 'INSERT' then
      raise exception 'A new article needs a cost price.'
        using errcode = 'P0001',
              hint = 'Enter the cost before adding ' || coalesce(new.sku, 'the article') || '.';
    elsif old.cost > 0 then
      raise exception 'An article''s cost price can''t be cleared.'
        using errcode = 'P0001',
              hint = 'Enter the new cost of ' || coalesce(new.sku, 'the article') || ' instead.';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists products_need_a_cost on public.products;
create trigger products_need_a_cost
  before insert or update of cost on public.products
  for each row execute function public.products_need_a_cost();

-- What it shows when it has run: one row, the trigger, enabled ('O').
select tgname, tgenabled
  from pg_trigger
 where tgrelid = 'public.products'::regclass
   and tgname = 'products_need_a_cost';
