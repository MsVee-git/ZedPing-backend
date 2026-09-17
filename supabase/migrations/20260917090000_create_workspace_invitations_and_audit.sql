create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  email_normalized text not null check (email_normalized = lower(trim(email_normalized))),
  intended_role text not null check (intended_role in ('admin', 'member')),
  invited_by_user_id uuid not null references auth.users(id) on delete restrict,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users(id) on delete set null,
  last_sent_at timestamptz,
  resend_count integer not null default 0 check (resend_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'accepted') or (accepted_at is not null and accepted_by_user_id is not null))
);

create unique index workspace_invitations_pending_email_unique
  on public.workspace_invitations(customer_id, email_normalized)
  where status = 'pending';

create index workspace_invitations_customer_status_expires_idx
  on public.workspace_invitations(customer_id, status, expires_at);

create table public.workspace_audit_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete set null,
  invitation_id uuid references public.workspace_invitations(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index workspace_audit_events_customer_created_idx
  on public.workspace_audit_events(customer_id, created_at desc);

alter table public.workspace_invitations enable row level security;
alter table public.workspace_audit_events enable row level security;
revoke all on public.workspace_invitations from anon, authenticated;
revoke all on public.workspace_audit_events from anon, authenticated;
