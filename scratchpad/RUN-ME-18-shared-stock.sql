-- ============================================================
-- FGT Billing — two or more products can share one stock figure.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Which products share a shelf
--
-- Products with the same stock_group_id are the same physical
-- stock sold under different SKUs. Null means the product keeps
-- its own count, which is every product today.
-- ------------------------------------------------------------
alter table public.products
  add column if not exists stock_group_id uuid;

comment on column public.products.stock_group_id is
  'Products sharing this id share one stock_on_hand figure. Null = own stock.';

create index if not exists products_stock_group_id_idx
  on public.products (stock_group_id)
  where stock_group_id is not null;


-- ------------------------------------------------------------
-- 2. Joining a group takes the group's figure
--
-- When a product is put under another product's stock, the
-- existing stock is the truth and the newcomer adopts it. This
-- runs BEFORE the row is written so the very first read after
-- linking already agrees.
-- ------------------------------------------------------------
create or replace function public.adopt_shared_stock()
returns trigger
language plpgsql
as $$
declare
  group_stock integer;
begin
  if new.stock_group_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.stock_group_id is not distinct from old.stock_group_id then
    return new;
  end if;
  select p.stock_on_hand into group_stock
  from public.products p
  where p.stock_group_id = new.stock_group_id
    and p.id <> new.id
  limit 1;
  if found then
    new.stock_on_hand := group_stock;
  end if;
  return new;
end;
$$;

drop trigger if exists products_stock_group_adopt on public.products;
create trigger products_stock_group_adopt
  before insert or update of stock_group_id on public.products
  for each row execute function public.adopt_shared_stock();


-- ------------------------------------------------------------
-- 3. A change to one is a change to all
--
-- Every path that moves stock — approving an order, granting an
-- edit, a goods return, a purchase, an import, the phone — reads
-- one product's stock_on_hand and writes it back. None of them
-- need to know about groups: this copies the new figure to every
-- other product in the group after the write.
--
-- It stops on its own. The copies fire this trigger again, but by
-- then every row in the group already holds the figure, so the
-- `is distinct from` test finds nothing left to change.
-- ------------------------------------------------------------
create or replace function public.mirror_shared_stock()
returns trigger
language plpgsql
as $$
begin
  if new.stock_group_id is null then
    return null;
  end if;
  if new.stock_on_hand is not distinct from old.stock_on_hand
     and new.stock_group_id is not distinct from old.stock_group_id then
    return null;
  end if;
  update public.products p
  set stock_on_hand = new.stock_on_hand
  where p.stock_group_id = new.stock_group_id
    and p.id <> new.id
    and p.stock_on_hand is distinct from new.stock_on_hand;
  return null;
end;
$$;

drop trigger if exists products_stock_group_mirror on public.products;
create trigger products_stock_group_mirror
  after update of stock_on_hand, stock_group_id on public.products
  for each row execute function public.mirror_shared_stock();


-- ------------------------------------------------------------
-- Check it worked. Every row below should say OK.
-- ------------------------------------------------------------
select 'products.stock_group_id' as item,
       case when exists (select 1 from information_schema.columns
                          where table_schema='public' and table_name='products'
                            and column_name='stock_group_id')
            then 'OK' else 'MISSING' end as status
union all
select 'adopt trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_adopt')
            then 'OK' else 'MISSING' end
union all
select 'mirror trigger',
       case when exists (select 1 from pg_trigger where tgname = 'products_stock_group_mirror')
            then 'OK' else 'MISSING' end
union all
select 'no group disagrees with itself',
       case when not exists (
              select 1 from public.products
              where stock_group_id is not null
              group by stock_group_id
              having count(distinct coalesce(stock_on_hand, -1)) > 1)
            then 'OK' else 'MISMATCH' end;
