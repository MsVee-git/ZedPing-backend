-- Persist only Meta asset identifiers for a verified Embedded Signup session.
-- Credentials remain exclusively in workspace_integration_credentials.
begin;

alter table public.whatsapp_connection_sessions
  add column if not exists signup_phone_number_id text,
  add column if not exists signup_waba_id text;

alter table public.whatsapp_connection_sessions
  drop constraint if exists whatsapp_connection_sessions_signup_phone_number_id_check;
alter table public.whatsapp_connection_sessions
  add constraint whatsapp_connection_sessions_signup_phone_number_id_check
  check (signup_phone_number_id is null or signup_phone_number_id ~ '^[0-9]{5,32}$');

alter table public.whatsapp_connection_sessions
  drop constraint if exists whatsapp_connection_sessions_signup_waba_id_check;
alter table public.whatsapp_connection_sessions
  add constraint whatsapp_connection_sessions_signup_waba_id_check
  check (signup_waba_id is null or signup_waba_id ~ '^[0-9]{5,32}$');

commit;
