-- Embedded Signup persists a number before it is operational. Keep that
-- transient state distinct from connected and disconnected numbers.
begin;

alter table public.whatsapp_numbers
  drop constraint if exists whatsapp_numbers_status_check;

alter table public.whatsapp_numbers
  add constraint whatsapp_numbers_status_check
  check (status in ('connected', 'disconnected', 'provisioning'));

commit;
