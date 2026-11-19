-- ============================================================
-- FGT Billing — the person who raised a goods return (GRV) can
-- edit it and add products to it while it is still pending.
--
-- Paste the whole thing into Supabase -> SQL Editor -> Run.
-- Check the address bar says the BILLING project
-- (isdeheipdfmwzmmnnidr), not Falcon.
-- Safe to run more than once. Changes no existing row.
--
-- Owner, 2026-11-19: "I want to be able to edit and add items in
-- GRV orders after making it." Asked who: managers and admins,
-- "also whoever raised it".
--
-- Managers and admins could already correct any return, pending
-- or approved (RUN-ME-25), and nothing about that changes. This
-- adds ONE way in for everybody else, and only through this
-- function — no update or delete policy is widened:
--
--   • only the return's own submitter;
--   • only while it is pending — an approved return has put stock
--     back and credited the customer, so correcting it stays a
--     manager's job;
--   • products, quantities, the amount and the note. Never the
--     customer, the status, who approved it, or its number.
--
-- The lines are replaced and the amount written in one
-- transaction, so a half-saved return cannot happen.
--
-- Until this is run, the apps tell a non-manager the edit needs
-- this file, and managers carry on as before.
-- ============================================================

create or replace function public.edit_own_pending_return(
  p_grv_id uuid,
  p_amount numeric,
  p_notes  text,
  p_lines  jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user      uuid := public.current_app_user_id();
  v_status    text;
  v_submitter uuid;
begin
  if v_user is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;

  select g.status::text, g.submitted_by into v_status, v_submitter
  from public.grv_returns g
  where g.id = p_grv_id
  for update;

  if v_status is null then
    raise exception 'Return not found.' using errcode = 'P0002';
  end if;
  if v_submitter is distinct from v_user then
    raise exception 'Only the person who raised this return can edit it.' using errcode = '42501';
  end if;
  if v_status <> 'pending' then
    raise exception 'This return has been approved. A manager can still correct it.' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'The products must be a list.' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) e
    where (e->>'product_id') is null
       or coalesce((e->>'qty')::integer, 0) <= 0
       or coalesce((e->>'unit_value')::numeric, -1) < 0
  ) then
    raise exception 'Every product needs a quantity of at least 1 and a value of 0 or more.' using errcode = '22023';
  end if;
  if p_amount is not null and p_amount < 0 then
    raise exception 'The amount cannot be negative.' using errcode = '22023';
  end if;

  delete from public.grv_items where grv_id = p_grv_id;

  insert into public.grv_items (grv_id, product_id, qty, unit_value)
  select p_grv_id,
         (e->>'product_id')::uuid,
         (e->>'qty')::integer,
         round((e->>'unit_value')::numeric, 2)
  from jsonb_array_elements(p_lines) e;

  update public.grv_returns
     set amount = case when p_amount is null then null else round(p_amount, 2) end,
         notes  = nullif(btrim(coalesce(p_notes, '')), '')
   where id = p_grv_id;
end;
$$;

revoke all on function public.edit_own_pending_return(uuid, numeric, text, jsonb) from public, anon;
grant execute on function public.edit_own_pending_return(uuid, numeric, text, jsonb) to authenticated;


-- ------------------------------------------------------------
-- Confirm
-- ------------------------------------------------------------
select 'edit_own_pending_return' as added,
       exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' and p.proname = 'edit_own_pending_return') as present;
