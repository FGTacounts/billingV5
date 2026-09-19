-- ============================================================
-- FGT Billing — stock never goes negative, and expenses can be
-- attributed to a salesman.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- Checked against the live database on 4 Sep 2026.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Stock on hand stops at zero
--
-- A shelf holds nothing or something; it never holds minus nine.
-- Four articles were already negative when this was written
-- (HBG274 -1, HBG275 -12, BG112 -9, BG108 -5) — the result of
-- approving orders for more than the system believed was there.
--
-- Both apps now clamp before writing, but the trigger is the one
-- that cannot be forgotten: it covers the phone, imports, and any
-- future code path, and it clamps rather than refusing, so an
-- approval is never blocked by a shelf count that was already wrong.
-- ------------------------------------------------------------
update public.products set stock_on_hand = 0 where stock_on_hand < 0;

create or replace function public.clamp_stock_on_hand()
returns trigger
language plpgsql
as $$
begin
  if new.stock_on_hand is not null and new.stock_on_hand < 0 then
    new.stock_on_hand := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists products_stock_floor on public.products;
create trigger products_stock_floor
  before insert or update of stock_on_hand on public.products
  for each row execute function public.clamp_stock_on_hand();


-- ------------------------------------------------------------
-- 2. Expenses can name the salesman they belong to
--
-- `logged_by` records who typed it in — always a manager, because
-- logging is manager-gated. That is not the same question as whose
-- expense it is, so the Expense page's Salesman tab was really
-- showing "expenses typed in by a salesman", which is nothing.
--
-- salesman_id is nullable on purpose: rent and utilities belong to
-- the business, not to a person.
-- ------------------------------------------------------------
alter table public.expenses
  add column if not exists salesman_id uuid references public.users(id);

create index if not exists expenses_salesman_id_idx
  on public.expenses (salesman_id, date desc);


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'no negative stock' as item,
       case when not exists (select 1 from public.products where stock_on_hand < 0)
            then 'OK' else 'STILL NEGATIVE' end as status
union all
select 'stock floor trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_floor')
            then 'OK' else 'MISSING' end
union all
select 'expenses.salesman_id',
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='expenses'
                            and column_name='salesman_id')
            then 'OK' else 'MISSING' end;
