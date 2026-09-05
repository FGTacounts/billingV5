alter table public.app_settings add column if not exists delivery_enabled boolean not null default true;
alter table public.app_settings add column if not exists cheque_drive_folder_id text;
alter table public.app_settings add column if not exists invoice_proof_drive_folder_id text;

update public.app_settings
   set cheque_drive_folder_id        = coalesce(cheque_drive_folder_id,        '1z_GV1W4YQDflS8IBQeNNvXvfGo5yEG2Q'),
       invoice_proof_drive_folder_id = coalesce(invoice_proof_drive_folder_id, '1HNKQrQ9F5ypv5AJAeBpof56LWzQ3unKC');

select delivery_enabled, cheque_drive_folder_id, invoice_proof_drive_folder_id
  from public.app_settings;
