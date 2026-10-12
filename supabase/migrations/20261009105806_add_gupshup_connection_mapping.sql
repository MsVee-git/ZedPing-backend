begin;
alter table public.whatsapp_connection_sessions
  add column onboarding_provider text not null default 'meta'
    check (onboarding_provider in ('meta', 'gupshup'));

-- Composite ownership reference prevents cross-workspace connection mappings.
alter table public.whatsapp_numbers
  add constraint whatsapp_numbers_id_customer_unique unique (id, customer_id);

create table public.gupshup_connection_mappings (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null unique,
  app_name text not null unique check (app_name ~ '^[A-Za-z0-9]{6,150}$'),
  wallet_id text not null check (wallet_id ~ '^[A-Za-z0-9-]+$'),
  app_id text unique check (app_id ~ '^[A-Za-z0-9-]+$'),
  link_state text not null default 'prepared'
    check (link_state in ('prepared','linking','linked','confirmation_required')),
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (whatsapp_number_id, customer_id)
    references public.whatsapp_numbers(id, customer_id) on delete cascade,
  check (link_state <> 'linked' or app_id is not null)
);
alter table public.gupshup_connection_mappings enable row level security;
revoke all on public.gupshup_connection_mappings from public, anon, authenticated;
grant select, insert, update, delete on public.gupshup_connection_mappings to service_role;
commit;
