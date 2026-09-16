create table if not exists public.workspace_discovery (
  customer_id uuid primary key references public.customers(id) on delete cascade,
  goals text[] not null default '{}'::text[],
  team_size text,
  contact_sources text[] not null default '{}'::text[],
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_discovery_team_size_check check (
    team_size is null or team_size in ('1', '2-5', '6-10', '11-25', '25+')
  )
);

create index if not exists workspace_discovery_completed_at_idx
  on public.workspace_discovery (completed_at);

alter table public.workspace_discovery enable row level security;

drop policy if exists workspace_discovery_select on public.workspace_discovery;
create policy workspace_discovery_select
on public.workspace_discovery
for select to authenticated
using (public.is_workspace_member(customer_id));