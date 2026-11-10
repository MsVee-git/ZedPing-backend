-- Prevent setup sessions opened before a disconnect from reactivating a number.
alter table public.whatsapp_numbers
  add column if not exists disconnected_at timestamptz;
