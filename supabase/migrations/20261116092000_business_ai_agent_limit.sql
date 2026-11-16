create function public.enforce_business_ai_agent_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  plan text;
begin
  if new.archived_at is not null or new.legacy_contained_at is not null then
    return new;
  end if;

  -- Serialize agent creation with other inserts and plan changes in this workspace.
  select subscription_plan into plan
  from public.customers
  where id = new.customer_id
  for no key update;

  if plan = 'business' and (
    select count(*)
    from public.ai_agents
    where customer_id = new.customer_id
      and archived_at is null
      and legacy_contained_at is null
  ) >= 2 then
    raise exception 'The Business plan includes up to 2 AI agents. Archive an agent before creating another.';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_business_ai_agent_limit() from public, anon, authenticated;

create trigger enforce_business_ai_agent_limit
before insert on public.ai_agents
for each row execute function public.enforce_business_ai_agent_limit();

