revoke select on public.products from authenticated;

grant select (
  id, sku, description, price, stock_on_hand, default_qty, rack_location,
  barcode, is_active, created_at, updated_at, "Product_category",
  vac_override, vac_china_override, stock_arrival_date,
  stock_holding_days_override
) on public.products to authenticated;

revoke select on public.order_items from authenticated;

grant select (
  id, order_id, product_id, sku, description, ordered_qty, picked_qty,
  unit_price, picked_by_id, picked_at, created_at
) on public.order_items to authenticated;

select table_name, column_name, 'STILL READABLE' as status
  from information_schema.column_privileges
 where grantee = 'authenticated'
   and privilege_type = 'SELECT'
   and (   (table_name = 'products'    and column_name = 'cost')
        or (table_name = 'order_items' and column_name = 'unit_cost'));
