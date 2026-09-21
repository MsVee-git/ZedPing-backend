-- D2.5 Phase 2: draft-only Zoe AI configuration, explicitly selected workspace Text knowledge, and isolated test usage.
alter table public.ai_agents
  add column if not exists zoe_template_key text,
  add column if not exists zoe_configuration jsonb not null default '{}'::jsonb;

create table if not exists public.ai_agent_configuration_versions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  version integer not null check (version > 0),
  configuration jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (agent_id, version)
);

create table if not exists public.ai_agent_knowledge_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  content_library_item_id uuid not null references public.content_library_items(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (agent_id, content_library_item_id)
);

create table if not exists public.ai_agent_test_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  agent_id uuid not null references public.ai_agents(id) on delete cascade,
  actor_user_id uuid,
  outcome text not null check (outcome in ('test_replied','would_handoff','failed')),
  knowledge_item_count integer not null default 0 check (knowledge_item_count >= 0),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  estimated_cost_usd numeric(14,8) check (estimated_cost_usd is null or estimated_cost_usd >= 0),
  created_at timestamptz not null default now()
);

create index if not exists ai_agent_knowledge_items_agent_idx on public.ai_agent_knowledge_items(agent_id);
create index if not exists ai_agent_test_events_workspace_created_idx on public.ai_agent_test_events(customer_id, created_at desc);

create or replace function public.enforce_ai_agent_knowledge_item_workspace_integrity()
returns trigger language plpgsql set search_path=public as $$
begin
  if not exists (
    select 1 from public.ai_agents a
    join public.content_library_items i on i.id = new.content_library_item_id
    where a.id = new.agent_id
      and a.customer_id = new.customer_id
      and a.legacy_contained_at is null
      and i.customer_id = new.customer_id
      and i.content_type = 'TEXT'
      and i.archived_at is null
  ) then
    raise exception 'AI knowledge must be an active Text item from the same workspace' using errcode='23514';
  end if;
  return new;
end;
$$;

drop trigger if exists ai_agent_knowledge_item_workspace_integrity on public.ai_agent_knowledge_items;
create trigger ai_agent_knowledge_item_workspace_integrity
before insert or update on public.ai_agent_knowledge_items
for each row execute function public.enforce_ai_agent_knowledge_item_workspace_integrity();

alter table public.ai_agent_configuration_versions enable row level security;
alter table public.ai_agent_knowledge_items enable row level security;
alter table public.ai_agent_test_events enable row level security;

drop policy if exists ai_agent_configuration_versions_read_workspace on public.ai_agent_configuration_versions;
create policy ai_agent_configuration_versions_read_workspace on public.ai_agent_configuration_versions
for select to authenticated using (public.is_workspace_member(customer_id));
drop policy if exists ai_agent_knowledge_items_read_workspace on public.ai_agent_knowledge_items;
create policy ai_agent_knowledge_items_read_workspace on public.ai_agent_knowledge_items
for select to authenticated using (public.is_workspace_member(customer_id));
drop policy if exists ai_agent_test_events_read_workspace on public.ai_agent_test_events;
create policy ai_agent_test_events_read_workspace on public.ai_agent_test_events
for select to authenticated using (public.is_workspace_member(customer_id));

revoke all on function public.enforce_ai_agent_knowledge_item_workspace_integrity() from public, anon, authenticated;
