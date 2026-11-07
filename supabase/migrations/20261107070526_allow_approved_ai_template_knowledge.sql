create or replace function public.enforce_ai_agent_knowledge_item_workspace_integrity()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if not exists (
    select 1 from public.ai_agents a
    join public.content_library_items i on i.id = new.content_library_item_id
    where a.id = new.agent_id
      and a.customer_id = new.customer_id
      and a.legacy_contained_at is null
      and i.customer_id = new.customer_id
      and i.archived_at is null
      and (
        i.content_type = 'TEXT'
        -- The workspace API verifies current approval against the live template catalogue.
        or (i.content_type = 'WHATSAPP_TEMPLATE_REFERENCE' and i.template_id is not null)
        or (i.content_type = 'IMAGE' and exists (
          select 1 from public.content_library_knowledge_revisions r
          where r.customer_id = new.customer_id and r.source_content_item_id = i.id
            and r.status = 'approved'
            and (r.valid_from is null or r.valid_from <= current_date)
            and (r.valid_until is null or r.valid_until >= current_date)
        ))
      )
  ) then
    raise exception 'AI knowledge must be an eligible Text, template reference or approved Image knowledge from the same workspace' using errcode='23514';
  end if;
  return new;
end;
$$;
