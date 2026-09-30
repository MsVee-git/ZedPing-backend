create table if not exists public.workspace_integration_credentials (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  integration text not null check (integration ~ '^[a-z][a-z0-9_]{0,63}$'),
  credential_key text not null check (credential_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  ciphertext text not null,
  iv text not null,
  auth_tag text not null,
  algorithm text not null check (algorithm = 'aes-256-gcm'),
  key_version integer not null check (key_version > 0 and key_version <= 65535),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, integration, credential_key)
);

alter table public.workspace_integration_credentials enable row level security;
revoke all on table public.workspace_integration_credentials from anon, authenticated;
create index if not exists workspace_integration_credentials_customer_lookup
  on public.workspace_integration_credentials (customer_id, integration, credential_key);
