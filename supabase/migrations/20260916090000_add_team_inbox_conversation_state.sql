alter table public.conversations
  add column if not exists control_mode text not null default 'automation',
  add column if not exists assigned_user_id uuid references auth.users(id) on delete set null,
  add column if not exists handoff_reason text,
  add column if not exists handoff_at timestamptz,
  add column if not exists taken_over_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by_user_id uuid references auth.users(id) on delete set null,
  add column if not exists last_message_at timestamptz,
  add column if not exists last_inbound_at timestamptz,
  add column if not exists last_outbound_at timestamptz,
  add column if not exists unread_count integer not null default 0;

alter table public.conversations drop constraint if exists conversations_control_mode_check;
alter table public.conversations
  add constraint conversations_control_mode_check check (control_mode in ('automation','needs_attention','human'));

alter table public.conversations drop constraint if exists conversations_status_check;
alter table public.conversations
  add constraint conversations_status_check check (status in ('open','needs_attention','resolved'));

create index if not exists conversations_workspace_activity_idx
  on public.conversations (customer_id, last_message_at desc);
create index if not exists conversations_workspace_assignee_idx
  on public.conversations (customer_id, assigned_user_id);

create table if not exists public.conversation_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists conversation_events_conversation_created_idx
  on public.conversation_events (conversation_id, created_at desc);

alter table public.conversation_events enable row level security;
drop policy if exists conversation_events_select on public.conversation_events;
create policy conversation_events_select on public.conversation_events
for select to authenticated
using (public.is_workspace_member(customer_id));