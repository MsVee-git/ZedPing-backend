-- Stage D2.3 Phase 1: tenant-scoped automation foundation and archival of audited unowned prototypes.
-- Applied to production through Supabase migration d23_automation_foundation_and_archive_orphans.
-- Kept in source control for deployment history.

begin;

alter table public.automations
  add column if not exists automation_type text,
  add column if not exists trigger_config jsonb not null default '{}'::jsonb,
  add column if not exists condition_config jsonb not null default '{}'::jsonb,
  add column if not exists action_config jsonb not null default '{}'::jsonb,
  add column if not exists content_library_item_id uuid references public.content_library_items(id) on delete set null,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_reason text,
  add column if not exists updated_at timestamptz not null default now();

alter table public.chatbot_sessions add column if not exists captured_fields jsonb not null default '{}'::jsonb;
alter table public.chatbot_steps add column if not exists capture_key text;

create table if not exists public.workspace_automation_settings (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  timezone text,
  business_hours jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (timezone is null or timezone ~ '^[A-Za-z_]+/[A-Za-z_]+$')
);
alter table public.workspace_automation_settings enable row level security;
create policy "automation settings workspace members can read" on public.workspace_automation_settings for select to authenticated using (public.is_workspace_member(customer_id));
create policy "automation settings workspace managers can manage" on public.workspace_automation_settings for all to authenticated using (public.is_workspace_manager(customer_id)) with check (public.is_workspace_manager(customer_id));

create table if not exists public.automation_welcome_deliveries (
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  first_automation_id uuid references public.automations(id) on delete set null,
  outbound_message_id uuid references public.messages(id) on delete set null,
  delivered_at timestamptz not null default now(),
  primary key (customer_id, whatsapp_number_id, contact_id)
);
alter table public.automation_welcome_deliveries enable row level security;
create policy "welcome deliveries workspace members can read" on public.automation_welcome_deliveries for select to authenticated using (public.is_workspace_member(customer_id));

create table if not exists public.automation_execution_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid references public.whatsapp_numbers(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  automation_id uuid references public.automations(id) on delete set null,
  event_type text not null check (event_type in ('triggered','skipped','response_sent','handoff_initiated','error')),
  outcome text not null check (outcome in ('success','skipped','error')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '90 days')
);
create index if not exists automation_execution_events_customer_created_idx on public.automation_execution_events(customer_id, created_at desc);
create index if not exists automation_execution_events_expiry_idx on public.automation_execution_events(expires_at);
alter table public.automation_execution_events enable row level security;
create policy "automation execution events workspace members can read" on public.automation_execution_events for select to authenticated using (public.is_workspace_member(customer_id));

-- Table-specific integrity triggers keep a child record inside its workspace.
-- Exact production migration includes idempotent policy/trigger drops.
-- The same definitions are retained there to avoid weakening D2.2 integrity rules.

create index if not exists automations_runtime_workspace_idx on public.automations(customer_id, is_active, priority, created_at, id) where archived_at is null and customer_id is not null;

commit;
