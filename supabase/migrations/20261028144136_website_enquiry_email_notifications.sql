alter table public.landing_page_leads add column notification_sent_at timestamptz, add column notification_next_at timestamptz, add column notification_attempts integer not null default 0, add column notification_provider_id text;
alter table public.landing_page_leads alter column notification_next_at set default now();
create index landing_leads_pending_email on public.landing_page_leads(notification_next_at) where notification_sent_at is null and notification_next_at is not null;
