select grantee, table_name, column_name
  from information_schema.column_privileges
 where table_schema = 'public'
   and privilege_type = 'SELECT'
   and (   (table_name = 'products'    and column_name = 'cost')
        or (table_name = 'order_items' and column_name = 'unit_cost'))
 order by table_name, grantee;
