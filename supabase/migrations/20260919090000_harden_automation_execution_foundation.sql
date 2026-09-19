-- Stage D2.2: tenant-safe automation/chatbot execution foundation.
-- Existing production data was checked for relationship and uniqueness conflicts before this migration.

alter table public.automations
  add column if not exists priority integer not null default 100;

alter table public.chatbot_sessions
  drop constraint if exists chatbot_sessions_contact_phone_key;

create unique index if not exists chatbot_sessions_workspace_number_contact_key
  on public.chatbot_sessions (customer_id, whatsapp_number_id, contact_phone);

create unique index if not exists ai_agents_one_active_per_number_key
  on public.ai_agents (customer_id, whatsapp_number_id)
  where is_active and whatsapp_number_id is not null;

create unique index if not exists ai_agent_sessions_one_active_per_contact_key
  on public.ai_agent_sessions (customer_id, whatsapp_number_id, contact_phone)
  where status = 'active' and whatsapp_number_id is not null and contact_phone is not null;

create unique index if not exists messages_inbound_meta_message_key
  on public.messages (whatsapp_number_id, meta_message_id)
  where direction = 'inbound' and meta_message_id is not null;

create table if not exists public.inbound_webhook_events (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
  meta_message_id text not null,
  created_at timestamptz not null default now(),
  unique (whatsapp_number_id, meta_message_id)
);

create index if not exists inbound_webhook_events_workspace_created_idx
  on public.inbound_webhook_events (customer_id, created_at desc);

alter table public.inbound_webhook_events enable row level security;

create or replace function public.is_workspace_manager(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.customers c
    where c.id = p_customer_id and c.auth_user_id = auth.uid()
  ) or exists (
    select 1 from public.workspace_members wm
    where wm.customer_id = p_customer_id
      and wm.user_id = auth.uid()
      and wm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_workspace_manager(uuid) from public;
grant execute on function public.is_workspace_manager(uuid) to authenticated;

create or replace function public.enforce_d2_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  linked_customer uuid;
  linked_number uuid;
  source_flow uuid;
  target_flow uuid;
begin
  if tg_table_name = 'automations' and new.chatbot_flow_id is not null then
    select customer_id into linked_customer from public.chatbot_flows where id = new.chatbot_flow_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'Automation chatbot flow must belong to the same workspace';
    end if;
  elsif tg_table_name = 'chatbot_flows' and new.whatsapp_number_id is not null then
    select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'Chatbot flow WhatsApp number must belong to the same workspace';
    end if;
  elsif tg_table_name = 'chatbot_steps' and tg_op = 'UPDATE' and new.flow_id is distinct from old.flow_id then
    if exists (
      select 1
      from public.chatbot_step_routes r
      where r.step_id = old.id or r.next_step_id = old.id
    ) or exists (
      select 1 from public.chatbot_sessions s where s.current_step_id = old.id
    ) then
      raise exception 'A chatbot step with routes or sessions cannot move between flows';
    end if;
  elsif tg_table_name = 'chatbot_step_routes' and new.next_step_id is not null then
    select flow_id into source_flow from public.chatbot_steps where id = new.step_id;
    select flow_id into target_flow from public.chatbot_steps where id = new.next_step_id;
    if source_flow is null or target_flow is null or source_flow <> target_flow then
      raise exception 'Chatbot step routes must remain within one flow';
    end if;
  elsif tg_table_name = 'chatbot_sessions' then
    select customer_id into linked_customer from public.chatbot_flows where id = new.flow_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'Chatbot session flow must belong to the same workspace';
    end if;
    if new.whatsapp_number_id is not null then
      select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Chatbot session WhatsApp number must belong to the same workspace';
      end if;
      select whatsapp_number_id into linked_number from public.chatbot_flows where id = new.flow_id;
      if linked_number is distinct from new.whatsapp_number_id then
        raise exception 'Chatbot session must use the flow WhatsApp number';
      end if;
    end if;
    if new.current_step_id is not null then
      select flow_id into source_flow from public.chatbot_steps where id = new.current_step_id;
      if source_flow is null or source_flow <> new.flow_id then
        raise exception 'Chatbot session step must belong to its flow';
      end if;
    end if;
  elsif tg_table_name = 'ai_agents' and new.whatsapp_number_id is not null then
    select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'AI agent WhatsApp number must belong to the same workspace';
    end if;
  elsif tg_table_name = 'ai_agent_sessions' then
    select customer_id, whatsapp_number_id into linked_customer, linked_number from public.ai_agents where id = new.agent_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'AI agent session agent must belong to the same workspace';
    end if;
    if new.whatsapp_number_id is not null then
      select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
      if linked_customer is null or linked_customer <> new.customer_id or linked_number is distinct from new.whatsapp_number_id then
        raise exception 'AI agent session WhatsApp number must match its agent and workspace';
      end if;
    end if;
  elsif tg_table_name = 'conversations' then
    if new.contact_id is not null then
      select customer_id into linked_customer from public.contacts where id = new.contact_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Conversation contact must belong to the same workspace';
      end if;
    end if;
    if new.whatsapp_number_id is not null then
      select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Conversation WhatsApp number must belong to the same workspace';
      end if;
    end if;
  elsif tg_table_name = 'messages' then
    if new.contact_id is not null then
      select customer_id into linked_customer from public.contacts where id = new.contact_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Message contact must belong to the same workspace';
      end if;
    end if;
    if new.conversation_id is not null then
      select customer_id, whatsapp_number_id into linked_customer, linked_number from public.conversations where id = new.conversation_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Message conversation must belong to the same workspace';
      end if;
      if new.whatsapp_number_id is not null and linked_number is not null and linked_number <> new.whatsapp_number_id then
        raise exception 'Message WhatsApp number must match its conversation';
      end if;
    end if;
    if new.whatsapp_number_id is not null then
      select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
      if linked_customer is null or linked_customer <> new.customer_id then
        raise exception 'Message WhatsApp number must belong to the same workspace';
      end if;
    end if;
  elsif tg_table_name = 'inbound_webhook_events' then
    select customer_id into linked_customer from public.whatsapp_numbers where id = new.whatsapp_number_id;
    if linked_customer is null or linked_customer <> new.customer_id then
      raise exception 'Inbound event WhatsApp number must belong to the same workspace';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists automations_workspace_integrity on public.automations;
create trigger automations_workspace_integrity before insert or update on public.automations
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists chatbot_flows_workspace_integrity on public.chatbot_flows;
create trigger chatbot_flows_workspace_integrity before insert or update on public.chatbot_flows
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists chatbot_steps_workspace_integrity on public.chatbot_steps;
create trigger chatbot_steps_workspace_integrity before update on public.chatbot_steps
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists chatbot_step_routes_workspace_integrity on public.chatbot_step_routes;
create trigger chatbot_step_routes_workspace_integrity before insert or update on public.chatbot_step_routes
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists chatbot_sessions_workspace_integrity on public.chatbot_sessions;
create trigger chatbot_sessions_workspace_integrity before insert or update on public.chatbot_sessions
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists ai_agents_workspace_integrity on public.ai_agents;
create trigger ai_agents_workspace_integrity before insert or update on public.ai_agents
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists ai_agent_sessions_workspace_integrity on public.ai_agent_sessions;
create trigger ai_agent_sessions_workspace_integrity before insert or update on public.ai_agent_sessions
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists conversations_workspace_integrity on public.conversations;
create trigger conversations_workspace_integrity before insert or update on public.conversations
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists messages_workspace_integrity on public.messages;
create trigger messages_workspace_integrity before insert or update on public.messages
for each row execute function public.enforce_d2_workspace_integrity();

drop trigger if exists inbound_webhook_events_workspace_integrity on public.inbound_webhook_events;
create trigger inbound_webhook_events_workspace_integrity before insert or update on public.inbound_webhook_events
for each row execute function public.enforce_d2_workspace_integrity();

-- Workspace members may inspect their automations and runtime state, but only
-- owners/admins may change configuration. Runtime writes are service-role only.
drop policy if exists "workspace access" on public.automations;
create policy automations_read_workspace on public.automations for select to authenticated
using (public.is_workspace_member(customer_id));
create policy automations_manage_workspace on public.automations for all to authenticated
using (public.is_workspace_manager(customer_id))
with check (public.is_workspace_manager(customer_id));

drop policy if exists "workspace access" on public.chatbot_flows;
create policy chatbot_flows_read_workspace on public.chatbot_flows for select to authenticated
using (public.is_workspace_member(customer_id));
create policy chatbot_flows_manage_workspace on public.chatbot_flows for all to authenticated
using (public.is_workspace_manager(customer_id))
with check (public.is_workspace_manager(customer_id));

drop policy if exists "workspace access" on public.chatbot_steps;
create policy chatbot_steps_read_workspace on public.chatbot_steps for select to authenticated
using (exists (select 1 from public.chatbot_flows f where f.id = chatbot_steps.flow_id and public.is_workspace_member(f.customer_id)));
create policy chatbot_steps_manage_workspace on public.chatbot_steps for all to authenticated
using (exists (select 1 from public.chatbot_flows f where f.id = chatbot_steps.flow_id and public.is_workspace_manager(f.customer_id)))
with check (exists (select 1 from public.chatbot_flows f where f.id = chatbot_steps.flow_id and public.is_workspace_manager(f.customer_id)));

drop policy if exists "workspace access" on public.chatbot_step_routes;
create policy chatbot_step_routes_read_workspace on public.chatbot_step_routes for select to authenticated
using (exists (
  select 1 from public.chatbot_steps s
  join public.chatbot_flows f on f.id = s.flow_id
  where s.id = chatbot_step_routes.step_id and public.is_workspace_member(f.customer_id)
));
create policy chatbot_step_routes_manage_workspace on public.chatbot_step_routes for all to authenticated
using (exists (
  select 1 from public.chatbot_steps s
  join public.chatbot_flows f on f.id = s.flow_id
  where s.id = chatbot_step_routes.step_id and public.is_workspace_manager(f.customer_id)
))
with check (exists (
  select 1 from public.chatbot_steps s
  join public.chatbot_flows f on f.id = s.flow_id
  where s.id = chatbot_step_routes.step_id and public.is_workspace_manager(f.customer_id)
));

drop policy if exists "workspace access" on public.ai_agents;
create policy ai_agents_read_workspace on public.ai_agents for select to authenticated
using (public.is_workspace_member(customer_id));
create policy ai_agents_manage_workspace on public.ai_agents for all to authenticated
using (public.is_workspace_manager(customer_id))
with check (public.is_workspace_manager(customer_id));

drop policy if exists "workspace access" on public.chatbot_sessions;
create policy chatbot_sessions_read_workspace on public.chatbot_sessions for select to authenticated
using (public.is_workspace_member(customer_id));

drop policy if exists "workspace access" on public.ai_agent_sessions;
create policy ai_agent_sessions_read_workspace on public.ai_agent_sessions for select to authenticated
using (public.is_workspace_member(customer_id));
