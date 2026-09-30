alter table public.whatsapp_numbers
  add column if not exists provisioning_state text,
  add column if not exists provisioning_error text,
  add column if not exists provisioning_attempts integer not null default 0,
  add column if not exists provisioning_started_at timestamptz,
  add column if not exists provisioned_at timestamptz;

alter table public.whatsapp_numbers
  drop constraint if exists whatsapp_numbers_provisioning_state_check;
alter table public.whatsapp_numbers
  add constraint whatsapp_numbers_provisioning_state_check check (provisioning_state is null or provisioning_state in ('embedded_signup_completed','provisioning','registering','operational','failed'));
