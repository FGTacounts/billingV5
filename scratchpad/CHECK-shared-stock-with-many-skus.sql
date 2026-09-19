-- ============================================================
-- FGT Billing — proof that one shelf can carry many SKUs.
--
-- Paste the whole file into Supabase -> SQL Editor -> Run.
--
-- THIS CHANGES NOTHING. Everything happens inside a transaction
-- that is rolled back at the end, on three invented products
-- that never touch your catalogue. Run it as often as you like.
--
-- WHY IT EXISTS
--
-- The shared-stock feature is meant for exactly what you
-- described: one physical stock sold online under several SKUs —
-- a size, a colour, a model number that has to appear on the
-- invoice. So SKU2 and SKU3 both hang off SKU1, and there is no
-- limit of two.
--
-- Reading the code says that. This makes the database say it,
-- on your own database, with your own triggers.
-- ============================================================

begin;

-- Three products standing in for SKU1, SKU2 and SKU3. Distinct
-- starting stock, so it is obvious which figure wins.
insert into public.products (sku, description, price, stock_on_hand, is_active)
values ('ZZ-CHECK-1', 'Shared stock check — the shelf', 10, 40, false),
       ('ZZ-CHECK-2', 'Shared stock check — second SKU', 10,  7, false),
       ('ZZ-CHECK-3', 'Shared stock check — third SKU', 10,  0, false);

select '1. before linking' as step,
       sku, stock_on_hand, stock_group_id
  from public.products
 where sku like 'ZZ-CHECK-%'
 order by sku;


-- SKU2 joins SKU1's shelf. SKU1 has no group yet, so it starts
-- one and SKU2 adopts its figure.
with shelf as (
  update public.products
     set stock_group_id = gen_random_uuid()
   where sku = 'ZZ-CHECK-1'
  returning stock_group_id
)
update public.products
   set stock_group_id = (select stock_group_id from shelf)
 where sku = 'ZZ-CHECK-2';

-- SKU3 joins the same shelf. This is the part worth proving:
-- nothing about the first link stops a third, or a fourth.
update public.products
   set stock_group_id = (select stock_group_id from public.products where sku = 'ZZ-CHECK-1')
 where sku = 'ZZ-CHECK-3';

select '2. all three on one shelf' as step,
       sku, stock_on_hand, stock_group_id
  from public.products
 where sku like 'ZZ-CHECK-%'
 order by sku;


-- Sell four of the THIRD SKU. The shelf is what moves, so every
-- one of them should read 36.
update public.products
   set stock_on_hand = stock_on_hand - 4
 where sku = 'ZZ-CHECK-3';

select '3. after selling 4 of the third SKU' as step,
       sku, stock_on_hand
  from public.products
 where sku like 'ZZ-CHECK-%'
 order by sku;


-- ------------------------------------------------------------
-- The verdict. Every row should say OK.
-- ------------------------------------------------------------
select 'three SKUs share one shelf' as item,
       case when (select count(distinct stock_group_id)
                    from public.products where sku like 'ZZ-CHECK-%') = 1
             and (select count(*)
                    from public.products where sku like 'ZZ-CHECK-%'
                     and stock_group_id is not null) = 3
            then 'OK' else 'NOT SHARED' end as status
union all
select 'joining adopted the shelf figure, not its own',
       case when (select stock_on_hand from public.products where sku = 'ZZ-CHECK-2') = 36
            then 'OK' else 'WRONG FIGURE' end
union all
select 'selling one SKU moved all three',
       case when (select count(distinct stock_on_hand)
                    from public.products where sku like 'ZZ-CHECK-%') = 1
             and (select stock_on_hand from public.products where sku = 'ZZ-CHECK-1') = 36
            then 'OK' else 'THEY DISAGREE' end;


-- Nothing above is kept.
rollback;


-- Proof the rollback worked: this must return no rows.
select 'left behind in your catalogue' as item, sku
  from public.products
 where sku like 'ZZ-CHECK-%';
