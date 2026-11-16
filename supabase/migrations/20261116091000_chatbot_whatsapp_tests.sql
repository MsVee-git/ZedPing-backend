create table public.chatbot_whatsapp_tests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
  flow_id uuid not null references public.chatbot_flows(id) on delete cascade,
  sender text not null check (sender ~ '^\+[1-9][0-9]{7,14}$'),
  start_code text not null,
  definition jsonb not null,
  content_items jsonb not null default '{}',
  inputs jsonb,
  expires_at timestamptz not null,
  unique (customer_id, whatsapp_number_id, sender)
);

alter table public.chatbot_whatsapp_tests enable row level security;
revoke all on public.chatbot_whatsapp_tests from anon, authenticated;
grant select, insert, update, delete on public.chatbot_whatsapp_tests to service_role;
create index chatbot_whatsapp_tests_flow_idx on public.chatbot_whatsapp_tests (flow_id);
create index chatbot_whatsapp_tests_expiry_idx on public.chatbot_whatsapp_tests (expires_at);

create extension if not exists pg_cron;
select cron.schedule(
  'delete-expired-chatbot-whatsapp-tests',
  '*/15 * * * *',
  $$delete from public.chatbot_whatsapp_tests where expires_at <= now()$$
);
