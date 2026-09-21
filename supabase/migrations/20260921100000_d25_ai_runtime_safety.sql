-- D2.5 Phase 1: AI runtime safety, legacy containment, bounded execution, and observability.

alter table public.ai_agents
  add column if not exists lifecycle_status text not null default 'draft',
  add column if not exists configuration_version integer not null default 1,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_reason text,
  add column if not exists legacy_contained_at timestamptz;

alter table public.ai_agents
  drop constraint if exists ai_agents_lifecycle_status_check;
alter table public.ai_agents
  add constraint ai_agents_lifecycle_status_check
  check (lifecycle_status in ('draft','active','paused','archived'));
alter table public.ai_agents
  drop constraint if exists ai_agents_configuration_version_check;
alter table public.ai_agents
  add constraint ai_agents_configuration_version_check check (configuration_version > 0);

alter table public.ai_agent_sessions
  add column if not exists contact_id uuid references public.contacts(id) on delete restrict,
  add column if not exists conversation_id uuid references public.conversations(id) on delete restrict,
  add column if not exists agent_version integer,
  add column if not exists started_at timestamptz,
  add column if not exists last_activity_at timestamptz,
  add column if not exists ended_at timestamptz,
  add column if not exists completion_reason text,
  add column if not exists expires_at timestamptz,
  add column if not exists legacy_contained_at timestamptz;

alter table public.ai_agent_sessions
  drop constraint if exists ai_agent_sessions_status_check;
alter table public.ai_agent_sessions
  add constraint ai_agent_sessions_status_check
  check (status in ('active','handed_off','ended','expired','failed','cancelled'));

-- These rows were independently identified as legacy and unscoped before this
-- migration. They are preserved, never assigned, and permanently excluded from
-- every tenant runtime path.
update public.ai_agents
set lifecycle_status = 'archived',
    is_active = false,
    archived_at = coalesce(archived_at, now()),
    archive_reason = coalesce(archive_reason, 'legacy_unscoped_pre_d25'),
    legacy_contained_at = coalesce(legacy_contained_at, now())
where (customer_id is null or whatsapp_number_id is null)
  and legacy_contained_at is null;

update public.ai_agent_sessions
set status = case when status = 'active' then 'ended' else status end,
    ended_at = coalesce(ended_at, now()),
    completion_reason = coalesce(completion_reason, 'legacy_unscoped_pre_d25'),
    legacy_contained_at = coalesce(legacy_contained_at, now())
where (customer_id is null or whatsapp_number_id is null)
  and legacy_contained_at is null;

create table if not exists public.ai_execution_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete restrict,
  agent_id uuid references public.ai_agents(id) on delete set null,
  ai_session_id uuid references public.ai_agent_sessions(id) on delete set null,
  agent_version integer,
  model text not null,
  outcome text not null check (outcome in ('replied','handed_off','blocked','failed')),
  error_category text,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  retrieval_item_ids uuid[] not null default '{}'::uuid[],
  retrieval_item_count integer not null default 0 check (retrieval_item_count >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_execution_events_workspace_created_idx
  on public.ai_execution_events(customer_id, created_at desc);
create index if not exists ai_execution_events_agent_created_idx
  on public.ai_execution_events(agent_id, created_at desc);
create index if not exists ai_agent_sessions_active_lookup_idx
  on public.ai_agent_sessions(customer_id, whatsapp_number_id, contact_phone)
  where status = 'active';

alter table public.ai_execution_events enable row level security;
drop policy if exists ai_execution_events_read_workspace on public.ai_execution_events;
create policy ai_execution_events_read_workspace on public.ai_execution_events
  for select to authenticated
  using (public.is_workspace_member(customer_id));

create or replace function public.enforce_ai_agent_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.legacy_contained_at is not null then
    if new.customer_id is not null or new.whatsapp_number_id is not null
       or new.lifecycle_status <> 'archived' or new.is_active then
      raise exception 'Legacy AI agents must remain unscoped and archived' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.customer_id is null or new.whatsapp_number_id is null then
    raise exception 'AI agents require a workspace and connected WhatsApp number' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id
      and n.customer_id = new.customer_id
      and n.status = 'connected'
  ) then
    raise exception 'AI agent WhatsApp number must belong to the same connected workspace' using errcode = '23514';
  end if;
  if new.lifecycle_status = 'active' and not new.is_active then
    raise exception 'Active AI agents must be enabled' using errcode = '23514';
  end if;
  if new.lifecycle_status <> 'active' and new.is_active then
    raise exception 'Only active AI agents may be enabled' using errcode = '23514';
  end if;
  if new.lifecycle_status = 'archived' and new.archived_at is null then
    new.archived_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.enforce_ai_agent_session_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.legacy_contained_at is not null then
    if new.customer_id is not null or new.whatsapp_number_id is not null or new.status = 'active' then
      raise exception 'Legacy AI sessions must remain unscoped and inactive' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.customer_id is null or new.whatsapp_number_id is null
     or new.agent_id is null or new.contact_id is null or new.conversation_id is null then
    raise exception 'AI sessions require workspace, WhatsApp number, agent, contact, and conversation' using errcode = '23514';
  end if;
  if not exists (
    select 1
    from public.ai_agents a
    join public.whatsapp_numbers n on n.id = new.whatsapp_number_id
    join public.contacts c on c.id = new.contact_id
    join public.conversations v on v.id = new.conversation_id
    where a.id = new.agent_id
      and a.customer_id = new.customer_id
      and a.whatsapp_number_id = new.whatsapp_number_id
      and (new.status <> 'active' or (a.lifecycle_status = 'active' and a.is_active))
      and n.customer_id = new.customer_id
      and n.status = 'connected'
      and c.customer_id = new.customer_id
      and v.customer_id = new.customer_id
      and v.whatsapp_number_id = new.whatsapp_number_id
      and v.contact_id = new.contact_id
  ) then
    raise exception 'AI session relationships must belong to one active workspace agent context' using errcode = '23514';
  end if;
  if new.agent_version is null or new.agent_version < 1 then
    raise exception 'AI session must record an agent configuration version' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_ai_execution_event_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id and n.customer_id = new.customer_id
  ) then
    raise exception 'AI execution event WhatsApp number must belong to its workspace' using errcode = '23514';
  end if;
  if new.agent_id is not null and not exists (
    select 1 from public.ai_agents a
    where a.id = new.agent_id and a.customer_id = new.customer_id and a.whatsapp_number_id = new.whatsapp_number_id
  ) then
    raise exception 'AI execution event agent must belong to its workspace and WhatsApp number' using errcode = '23514';
  end if;
  if new.ai_session_id is not null and not exists (
    select 1 from public.ai_agent_sessions s
    where s.id = new.ai_session_id and s.customer_id = new.customer_id and s.whatsapp_number_id = new.whatsapp_number_id
  ) then
    raise exception 'AI execution event session must belong to its workspace and WhatsApp number' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_execution_events_workspace_integrity on public.ai_execution_events;
create trigger ai_execution_events_workspace_integrity
before insert or update on public.ai_execution_events
for each row execute function public.enforce_ai_execution_event_workspace_integrity();

revoke all on function public.enforce_ai_execution_event_workspace_integrity() from public, anon, authenticated;
