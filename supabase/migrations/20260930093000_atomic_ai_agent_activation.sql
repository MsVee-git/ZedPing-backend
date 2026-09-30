-- Atomically promote the server-built draft configuration into one immutable
-- activated version. The function is deliberately callable only by the
-- backend service role; browser callers continue through the owner/admin API.
create or replace function public.activate_ai_agent_version(
  p_customer_id uuid,
  p_agent_id uuid,
  p_expected_configuration_version integer,
  p_expected_lifecycle_status text,
  p_target_deployment_mode text,
  p_configuration jsonb,
  p_knowledge_snapshot jsonb,
  p_created_by uuid
)
returns table (version integer, activated_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  current_agent public.ai_agents%rowtype;
  next_version integer;
  activated_time timestamptz := clock_timestamp();
begin
  select * into current_agent
  from public.ai_agents
  where id = p_agent_id
    and customer_id = p_customer_id
    and legacy_contained_at is null
  for update;

  if not found then
    raise exception 'AI Agent was not found in this workspace' using errcode = 'P0001';
  end if;

  if current_agent.configuration_version is distinct from p_expected_configuration_version
     or current_agent.lifecycle_status is distinct from p_expected_lifecycle_status then
    raise exception 'AI Agent changed before activation; review it again' using errcode = '40001';
  end if;

  if current_agent.lifecycle_status not in ('draft', 'paused', 'active') then
    raise exception 'Only a draft, paused, or active AI Agent can be activated' using errcode = 'P0001';
  end if;

  if p_target_deployment_mode not in ('test', 'live') then
    raise exception 'AI Agent deployment mode is invalid' using errcode = '22023';
  end if;

  if current_agent.lifecycle_status = 'active'
     and p_target_deployment_mode is distinct from coalesce(current_agent.deployment_mode, 'test') then
    raise exception 'Updating a live AI Agent must preserve its deployment mode' using errcode = 'P0001';
  end if;

  if current_agent.lifecycle_status <> 'active' and p_target_deployment_mode <> 'test' then
    raise exception 'A newly activated AI Agent starts in Test Mode' using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from public.whatsapp_numbers number
    where number.id = current_agent.whatsapp_number_id
      and number.customer_id = p_customer_id
      and number.status = 'connected'
  ) then
    raise exception 'AI Agent WhatsApp number must remain connected in this workspace' using errcode = '23514';
  end if;

  if p_configuration is null
     or jsonb_typeof(p_configuration) <> 'object'
     or nullif(trim(coalesce(p_configuration->>'name', '')), '') is null
     or p_configuration->>'whatsapp_number_id' is distinct from current_agent.whatsapp_number_id::text
     or jsonb_typeof(p_configuration->'configuration'->'handoff') <> 'object' then
    raise exception 'AI Agent activation configuration is invalid' using errcode = '23514';
  end if;

  if p_knowledge_snapshot is null
     or jsonb_typeof(p_knowledge_snapshot) <> 'array'
     or jsonb_array_length(p_knowledge_snapshot) = 0 then
    raise exception 'AI Agent activation knowledge snapshot is invalid' using errcode = '23514';
  end if;

  if exists (
    select 1
    from public.ai_agents other_agent
    where other_agent.customer_id = p_customer_id
      and other_agent.whatsapp_number_id = current_agent.whatsapp_number_id
      and other_agent.lifecycle_status = 'active'
      and other_agent.is_active = true
      and other_agent.legacy_contained_at is null
      and other_agent.id <> current_agent.id
  ) then
    raise exception 'Another active AI Agent already uses this WhatsApp number' using errcode = '23505';
  end if;

  next_version := current_agent.configuration_version + 1;

  insert into public.ai_agent_configuration_versions (
    customer_id,
    agent_id,
    version,
    configuration,
    knowledge_snapshot,
    activated_at,
    created_by
  ) values (
    p_customer_id,
    current_agent.id,
    next_version,
    p_configuration,
    p_knowledge_snapshot,
    activated_time,
    p_created_by
  );

  update public.ai_agents
  set lifecycle_status = 'active',
      is_active = true,
      deployment_mode = p_target_deployment_mode,
      configuration_version = next_version,
      archived_at = null,
      archive_reason = null
  where id = current_agent.id
    and customer_id = p_customer_id;

  return query select next_version, activated_time;
end;
$$;

revoke all on function public.activate_ai_agent_version(uuid, uuid, integer, text, text, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function public.activate_ai_agent_version(uuid, uuid, integer, text, text, jsonb, jsonb, uuid) to service_role;
