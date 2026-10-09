-- ============================================================
-- FGT Billing — stock adjustments happen in one atomic UPDATE,
-- not a read into the app and a write back.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- Found 2026-09-28: HBG235, HBG434, HBG378, HBG380 and others were
-- stuck at stock_on_hand = 0 on the phone even though the shelf
-- was not actually empty. RUN-ME-8 already clamps a negative write
-- to zero, and its own note says why one was needed: "the result
-- of approving orders for more than the system believed was there."
-- That is the same disease this is the other half of the cure for.
--
-- Both the web and the phone approved an order by reading a
-- product's stock_on_hand, subtracting the picked quantity in
-- application code, and writing the result back (order approval,
-- unapprove, a granted edit, a goods return). Two of those
-- read-write round trips overlapping for the same SKU — two
-- managers approving orders for it within the same second, or an
-- approval racing a manual correction — can both read the same
-- starting figure and each write have-need. The second write
-- throws away the first one's deduction instead of adding to it,
-- rather than a database transaction serializing the two the way
-- assign_invoice_number (invoice-numbering-migration.sql) already
-- does for the number itself.
--
-- adjust_stock_by_sku(sku, delta) moves the subtraction into the
-- UPDATE statement itself, so Postgres' own row lock does the
-- serializing: whoever's write commits second sees the first one's
-- result, not the figure from before either ran. It runs SECURITY
-- INVOKER (the default) so RLS on products still applies to the
-- caller — this grants no more than a direct UPDATE already could.
--
-- It relies on two triggers that are already live (RUN-ME-8,
-- RUN-ME-18): products_stock_floor clamps a negative result to
-- zero, and products_stock_group_mirror copies the new figure onto
-- every other SKU on a shared shelf. Neither is repeated here.
--
-- A null stock_on_hand means the product is not tracked at all —
-- "an uncounted shelf is not an empty one" — so the where clause
-- leaves those rows alone and the function returns null, the same
-- meaning the app's own `counted` check already gives that case.
-- ------------------------------------------------------------
create or replace function public.adjust_stock_by_sku(p_sku text, p_delta integer)
returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_new integer;
begin
  update public.products
  set stock_on_hand = stock_on_hand + p_delta
  where sku = p_sku
    and stock_on_hand is not null
  returning stock_on_hand into v_new;

  return v_new;
end;
$$;

grant execute on function public.adjust_stock_by_sku(text, integer) to authenticated;


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'adjust_stock_by_sku exists' as item,
       case when exists (
              select 1 from pg_proc p
              join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'adjust_stock_by_sku')
            then 'OK' else 'MISSING' end as status
union all
select 'authenticated can call it',
       case when exists (
              select 1 from information_schema.role_routine_grants
              where routine_schema = 'public'
                and routine_name = 'adjust_stock_by_sku'
                and grantee = 'authenticated')
            then 'OK' else 'MISSING' end
union all
select 'stock floor trigger (RUN-ME-8) is live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_floor')
            then 'OK' else 'MISSING — run RUN-ME-8 first' end
union all
select 'shared-stock mirror trigger (RUN-ME-18) is live',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_mirror')
            then 'OK' else 'MISSING — run RUN-ME-18 first' end;
