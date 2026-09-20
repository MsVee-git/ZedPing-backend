begin;
alter table public.automation_welcome_deliveries
  alter column delivered_at drop not null,
  add column if not exists status text not null default 'pending' check (status in ('pending','sent')),
  add column if not exists claimed_at timestamptz not null default now();
commit;
