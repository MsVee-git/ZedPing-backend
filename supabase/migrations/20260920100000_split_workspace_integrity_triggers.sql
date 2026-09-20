-- Stage D2.2: replace the unsafe polymorphic trigger with table-specific checks.
-- Each trigger references only columns that exist on its own table.

create or replace function public.enforce_automation_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.chatbot_flow_id is not null and not exists (
    select 1
    from public.chatbot_flows f
    where f.id = new.chatbot_flow_id
      and f.customer_id = new.customer_id
  ) then
    raise exception 'Automation chatbot flow must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_chatbot_flow_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.whatsapp_number_id is not null and not exists (
    select 1
    from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id
      and n.customer_id = new.customer_id
  ) then
    raise exception 'Chatbot flow WhatsApp number must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_chatbot_step_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.next_step_id is not null and not exists (
    select 1
    from public.chatbot_steps target
    where target.id = new.next_step_id
      and target.flow_id = new.flow_id
  ) then
    raise exception 'Chatbot step next step must belong to the same flow' using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and new.flow_id is distinct from old.flow_id and (
    exists (
      select 1 from public.chatbot_step_routes r
      where r.step_id = old.id or r.next_step_id = old.id
    )
    or exists (
      select 1 from public.chatbot_sessions s
      where s.current_step_id = old.id
    )
    or exists (
      select 1 from public.chatbot_steps s
      where s.next_step_id = old.id
    )
  ) then
    raise exception 'A chatbot step with linked routes, sessions, or steps cannot move between flows' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_chatbot_route_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.chatbot_steps source
    join public.chatbot_steps target on target.id = new.next_step_id
    where source.id = new.step_id
      and source.flow_id = target.flow_id
  ) then
    raise exception 'Chatbot step routes must remain within one flow' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_chatbot_session_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.chatbot_flows f
    where f.id = new.flow_id
      and f.customer_id = new.customer_id
  ) then
    raise exception 'Chatbot session flow must belong to the same workspace' using errcode = '23514';
  end if;

  if new.whatsapp_number_id is not null and not exists (
    select 1
    from public.whatsapp_numbers n
    join public.chatbot_flows f on f.id = new.flow_id
    where n.id = new.whatsapp_number_id
      and n.customer_id = new.customer_id
      and f.whatsapp_number_id = new.whatsapp_number_id
  ) then
    raise exception 'Chatbot session WhatsApp number must match its flow and workspace' using errcode = '23514';
  end if;

  if new.current_step_id is not null and not exists (
    select 1
    from public.chatbot_steps s
    where s.id = new.current_step_id
      and s.flow_id = new.flow_id
  ) then
    raise exception 'Chatbot session step must belong to its flow' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_ai_agent_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.whatsapp_number_id is not null and not exists (
    select 1
    from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id
      and n.customer_id = new.customer_id
  ) then
    raise exception 'AI agent WhatsApp number must belong to the same workspace' using errcode = '23514';
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
  if not exists (
    select 1
    from public.ai_agents a
    where a.id = new.agent_id
      and a.customer_id = new.customer_id
  ) then
    raise exception 'AI agent session agent must belong to the same workspace' using errcode = '23514';
  end if;

  if new.whatsapp_number_id is not null and not exists (
    select 1
    from public.ai_agents a
    join public.whatsapp_numbers n on n.id = new.whatsapp_number_id
    where a.id = new.agent_id
      and a.customer_id = new.customer_id
      and a.whatsapp_number_id = new.whatsapp_number_id
      and n.customer_id = new.customer_id
  ) then
    raise exception 'AI agent session WhatsApp number must match its agent and workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_conversation_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.contact_id is not null and not exists (
    select 1 from public.contacts c
    where c.id = new.contact_id and c.customer_id = new.customer_id
  ) then
    raise exception 'Conversation contact must belong to the same workspace' using errcode = '23514';
  end if;

  if new.whatsapp_number_id is not null and not exists (
    select 1 from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id and n.customer_id = new.customer_id
  ) then
    raise exception 'Conversation WhatsApp number must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_message_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.contact_id is not null and not exists (
    select 1 from public.contacts c
    where c.id = new.contact_id and c.customer_id = new.customer_id
  ) then
    raise exception 'Message contact must belong to the same workspace' using errcode = '23514';
  end if;

  if new.conversation_id is not null and not exists (
    select 1
    from public.conversations c
    where c.id = new.conversation_id
      and c.customer_id = new.customer_id
      and (
        new.whatsapp_number_id is null
        or c.whatsapp_number_id is null
        or c.whatsapp_number_id = new.whatsapp_number_id
      )
  ) then
    raise exception 'Message conversation must belong to the same workspace and WhatsApp number' using errcode = '23514';
  end if;

  if new.whatsapp_number_id is not null and not exists (
    select 1 from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id and n.customer_id = new.customer_id
  ) then
    raise exception 'Message WhatsApp number must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_inbound_webhook_event_workspace_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.whatsapp_numbers n
    where n.id = new.whatsapp_number_id and n.customer_id = new.customer_id
  ) then
    raise exception 'Inbound event WhatsApp number must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists automations_workspace_integrity on public.automations;
create trigger automations_workspace_integrity before insert or update on public.automations
for each row execute function public.enforce_automation_workspace_integrity();

drop trigger if exists chatbot_flows_workspace_integrity on public.chatbot_flows;
create trigger chatbot_flows_workspace_integrity before insert or update on public.chatbot_flows
for each row execute function public.enforce_chatbot_flow_workspace_integrity();

drop trigger if exists chatbot_steps_workspace_integrity on public.chatbot_steps;
create trigger chatbot_steps_workspace_integrity before update on public.chatbot_steps
for each row execute function public.enforce_chatbot_step_workspace_integrity();

drop trigger if exists chatbot_step_routes_workspace_integrity on public.chatbot_step_routes;
create trigger chatbot_step_routes_workspace_integrity before insert or update on public.chatbot_step_routes
for each row execute function public.enforce_chatbot_route_workspace_integrity();

drop trigger if exists chatbot_sessions_workspace_integrity on public.chatbot_sessions;
create trigger chatbot_sessions_workspace_integrity before insert or update on public.chatbot_sessions
for each row execute function public.enforce_chatbot_session_workspace_integrity();

drop trigger if exists ai_agents_workspace_integrity on public.ai_agents;
create trigger ai_agents_workspace_integrity before insert or update on public.ai_agents
for each row execute function public.enforce_ai_agent_workspace_integrity();

drop trigger if exists ai_agent_sessions_workspace_integrity on public.ai_agent_sessions;
create trigger ai_agent_sessions_workspace_integrity before insert or update on public.ai_agent_sessions
for each row execute function public.enforce_ai_agent_session_workspace_integrity();

drop trigger if exists conversations_workspace_integrity on public.conversations;
create trigger conversations_workspace_integrity before insert or update on public.conversations
for each row execute function public.enforce_conversation_workspace_integrity();

drop trigger if exists messages_workspace_integrity on public.messages;
create trigger messages_workspace_integrity before insert or update on public.messages
for each row execute function public.enforce_message_workspace_integrity();

drop trigger if exists inbound_webhook_events_workspace_integrity on public.inbound_webhook_events;
create trigger inbound_webhook_events_workspace_integrity before insert or update on public.inbound_webhook_events
for each row execute function public.enforce_inbound_webhook_event_workspace_integrity();

drop function if exists public.enforce_d2_workspace_integrity();
