-- Durable, service-dispatched AI follow-ups. Never grant client writes.
create table public.ai_lead_followup_jobs (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete cascade,
 conversation_id uuid not null references public.conversations(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
 agent_id uuid not null references public.ai_agents(id) on delete cascade,
 session_id uuid not null references public.ai_agent_sessions(id) on delete cascade,
 agent_version integer not null check(agent_version > 0),
 anchor_at timestamptz not null,
 step integer not null check(step in (1,24,72,96)),
 due_at timestamptz not null,
 template_id text,
 state text not null default 'queued' check(state in ('queued','running','done','blocked','cancelled','failed')),
 reason text,
 started_at timestamptz,
 finished_at timestamptz,
 created_at timestamptz not null default now(),
 unique(conversation_id,anchor_at,step),
 check((step in (24,72) and template_id is not null) or (step in (1,96) and template_id is null)),
 check(due_at = anchor_at + step * interval '1 hour')
);
create index ai_lead_followups_due_idx on public.ai_lead_followup_jobs(due_at) where state='queued';
create index ai_lead_followups_conversation_idx on public.ai_lead_followup_jobs(customer_id,conversation_id) where state='queued';
alter table public.ai_lead_followup_jobs enable row level security;
revoke all on public.ai_lead_followup_jobs from anon,authenticated;
grant all on public.ai_lead_followup_jobs to service_role;
-- Check references even for privileged inserts; a malformed job must never cross workspaces.
create function public.check_lead_followup_workspace() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
 if not exists(select 1 from public.conversations c where c.id=new.conversation_id and c.customer_id=new.customer_id and c.contact_id=new.contact_id and c.whatsapp_number_id=new.whatsapp_number_id)
 or not exists(select 1 from public.ai_agents a where a.id=new.agent_id and a.customer_id=new.customer_id and a.whatsapp_number_id=new.whatsapp_number_id)
 or not exists(select 1 from public.ai_agent_sessions s where s.id=new.session_id and s.customer_id=new.customer_id and s.conversation_id=new.conversation_id and s.agent_id=new.agent_id and s.agent_version=new.agent_version)
 then raise exception 'Follow-up references must belong to the same workspace and conversation'; end if;
 return new;
end $$;
revoke execute on function public.check_lead_followup_workspace() from public,anon,authenticated;
create trigger ai_lead_followup_workspace_check before insert or update of customer_id,conversation_id,contact_id,whatsapp_number_id,agent_id,session_id,agent_version on public.ai_lead_followup_jobs for each row execute function public.check_lead_followup_workspace();
