begin;
alter table public.gupshup_connection_mappings
 add constraint gupshup_mapping_app_connection_owner_unique unique(app_id, whatsapp_number_id, customer_id);
create table public.gupshup_webhook_events (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null,
 whatsapp_number_id uuid not null,
 app_id text not null,
 event_key text not null check(length(event_key) between 1 and 1024),
 event_type text not null check(event_type in ('message','status')),
 payload jsonb not null,
 processing_state text not null default 'pending' check(processing_state in ('pending','processing','complete','failed')),
 created_at timestamptz not null default now(),
 unique(app_id,event_key),
 foreign key(app_id,whatsapp_number_id,customer_id)
  references public.gupshup_connection_mappings(app_id,whatsapp_number_id,customer_id) on delete cascade
);
alter table public.gupshup_webhook_events enable row level security;
revoke all on public.gupshup_webhook_events from public, anon, authenticated;
grant select, insert, update, delete on public.gupshup_webhook_events to service_role;
create index gupshup_webhook_pending on public.gupshup_webhook_events(created_at) where processing_state = 'pending';
commit;
