-- Separate a safely retryable interruption from an uncertain registration
-- outcome. The latter must never trigger a blind second Meta registration.
begin;

alter table public.whatsapp_numbers
  add column if not exists provisioning_claimed_at timestamptz,
  add column if not exists provisioning_registration_attempted_at timestamptz;

alter table public.whatsapp_numbers
  drop constraint if exists whatsapp_numbers_provisioning_state_check;
alter table public.whatsapp_numbers
  add constraint whatsapp_numbers_provisioning_state_check
  check (provisioning_state is null or provisioning_state in (
    'embedded_signup_completed',
    'provisioning',
    'registering',
    'operational',
    'failed',
    'registration_confirmation_required'
  ));

commit;
