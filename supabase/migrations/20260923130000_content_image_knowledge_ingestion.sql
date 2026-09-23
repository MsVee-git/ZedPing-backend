-- Content Library-owned, review-first knowledge extraction. Raw extraction is
-- never eligible for Zoe until an owner/admin approves a revision.
create table if not exists public.content_library_ingestions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  source_content_item_id uuid not null references public.content_library_items(id) on delete cascade,
  source_kind text not null check (source_kind in ('IMAGE')),
  status text not null default 'pending' check (status in ('pending','processing','ready_for_review','approved','rejected','failed')),
  extracted_text text,
  review_notes jsonb not null default '[]'::jsonb,
  error_category text,
  created_by uuid references auth.users(id),
  reviewed_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists content_library_ingestions_source_idx on public.content_library_ingestions(customer_id, source_content_item_id, created_at desc);

-- Keep the source relationship authoritative: an ingestion can only be for an
-- active IMAGE owned by the same workspace. This trigger is also used by the
-- service-role runtime, so a guessed source id cannot cross a tenant boundary.
create or replace function public.enforce_content_image_ingestion_integrity()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if not exists (
    select 1 from public.content_library_items item
    where item.id = new.source_content_item_id
      and item.customer_id = new.customer_id
      and item.content_type = 'IMAGE'
      and item.archived_at is null
  ) then
    raise exception 'Image knowledge ingestion source must be an active Image item from the same workspace' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists content_image_ingestion_integrity on public.content_library_ingestions;
create trigger content_image_ingestion_integrity
before insert or update on public.content_library_ingestions
for each row execute function public.enforce_content_image_ingestion_integrity();

create table if not exists public.content_library_knowledge_revisions (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  source_content_item_id uuid not null references public.content_library_items(id) on delete cascade,
  ingestion_id uuid not null references public.content_library_ingestions(id) on delete restrict,
  revision integer not null check (revision > 0),
  text_content text not null check (char_length(btrim(text_content)) between 1 and 20000),
  valid_from date,
  valid_until date,
  status text not null default 'approved' check (status in ('approved','superseded','rejected')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz not null default now(),
  unique (source_content_item_id, revision),
  check (valid_from is null or valid_until is null or valid_from <= valid_until)
);
create unique index if not exists content_library_one_current_approved_knowledge
  on public.content_library_knowledge_revisions(source_content_item_id) where status='approved';
create index if not exists content_library_knowledge_eligible_idx
  on public.content_library_knowledge_revisions(customer_id, source_content_item_id, approved_at desc) where status='approved';

create or replace function public.enforce_content_image_knowledge_revision_integrity()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  if not exists (
    select 1 from public.content_library_ingestions ingestion
    join public.content_library_items item on item.id = ingestion.source_content_item_id
    where ingestion.id = new.ingestion_id
      and ingestion.customer_id = new.customer_id
      and ingestion.source_content_item_id = new.source_content_item_id
      and item.customer_id = new.customer_id
      and item.content_type = 'IMAGE'
  ) then
    raise exception 'Image knowledge revision must use an ingestion and source from the same workspace' using errcode='23514';
  end if;
  return new;
end;
$$;
drop trigger if exists content_image_knowledge_revision_integrity on public.content_library_knowledge_revisions;
create trigger content_image_knowledge_revision_integrity
before insert or update on public.content_library_knowledge_revisions
for each row execute function public.enforce_content_image_knowledge_revision_integrity();

-- Approval is atomic so a source can have exactly one current approved
-- revision while retaining every historical revision. It is intentionally
-- callable only by the service-role backend after its owner/admin check.
create or replace function public.approve_content_image_knowledge(
  p_customer_id uuid,
  p_ingestion_id uuid,
  p_text_content text,
  p_valid_from date default null,
  p_valid_until date default null,
  p_actor_user_id uuid default null
)
returns public.content_library_knowledge_revisions
language plpgsql security definer set search_path=public,pg_temp as $$
declare
  source_id uuid;
  next_revision integer;
  approved public.content_library_knowledge_revisions;
begin
  if char_length(btrim(coalesce(p_text_content, ''))) not between 1 and 20000 then
    raise exception 'Reviewed knowledge is required';
  end if;
  if p_valid_from is not null and p_valid_until is not null and p_valid_from > p_valid_until then
    raise exception 'Valid until cannot be before valid from';
  end if;
  select source_content_item_id into source_id
  from public.content_library_ingestions
  where id = p_ingestion_id and customer_id = p_customer_id and status = 'ready_for_review'
  for update;
  if source_id is null then
    raise exception 'This extraction is not ready for approval';
  end if;
  update public.content_library_knowledge_revisions
     set status = 'superseded'
   where customer_id = p_customer_id and source_content_item_id = source_id and status = 'approved';
  select coalesce(max(revision), 0) + 1 into next_revision
    from public.content_library_knowledge_revisions where source_content_item_id = source_id;
  insert into public.content_library_knowledge_revisions
    (customer_id, source_content_item_id, ingestion_id, revision, text_content, valid_from, valid_until, status, approved_by)
  values (p_customer_id, source_id, p_ingestion_id, next_revision, btrim(p_text_content), p_valid_from, p_valid_until, 'approved', p_actor_user_id)
  returning * into approved;
  update public.content_library_ingestions
     set status = 'approved', reviewed_by = p_actor_user_id, reviewed_at = now(), updated_at = now()
   where id = p_ingestion_id and customer_id = p_customer_id;
  return approved;
end;
$$;

alter table public.content_library_ingestions enable row level security;
alter table public.content_library_knowledge_revisions enable row level security;
create policy content_library_ingestions_read_workspace on public.content_library_ingestions for select to authenticated using (public.is_workspace_member(customer_id));
create policy content_library_knowledge_revisions_read_workspace on public.content_library_knowledge_revisions for select to authenticated using (public.is_workspace_member(customer_id));

revoke all on function public.enforce_content_image_ingestion_integrity() from public, anon, authenticated;
revoke all on function public.enforce_content_image_knowledge_revision_integrity() from public, anon, authenticated;
revoke all on function public.approve_content_image_knowledge(uuid, uuid, text, date, date, uuid) from public, anon, authenticated;
grant execute on function public.approve_content_image_knowledge(uuid, uuid, text, date, date, uuid) to service_role;

-- Keep AI knowledge association integrity compatible with both existing Text
-- items and current approved image-derived revisions. Raw images stay ineligible.
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
        or (i.content_type = 'IMAGE' and exists (
          select 1 from public.content_library_knowledge_revisions r
          where r.customer_id = new.customer_id and r.source_content_item_id = i.id
            and r.status = 'approved'
            and (r.valid_from is null or r.valid_from <= current_date)
            and (r.valid_until is null or r.valid_until >= current_date)
        ))
      )
  ) then
    raise exception 'AI knowledge must be an eligible Text item or approved Image knowledge from the same workspace' using errcode='23514';
  end if;
  return new;
end;
$$;
