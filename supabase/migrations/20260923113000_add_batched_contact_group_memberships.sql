-- Batched contact-group membership operations. These are intentionally
-- service-role only: the application API performs authenticated manager
-- authorization, while the functions independently scope every group and
-- contact to the supplied workspace.

create or replace function public.add_contact_group_members_batch(
  p_customer_id uuid,
  p_group_id uuid,
  p_contact_ids uuid[]
)
returns table (
  added_count integer,
  already_member_count integer,
  failed_count integer,
  member_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_count integer := 0;
  v_eligible_count integer := 0;
  v_existing_count integer := 0;
  v_added_count integer := 0;
  v_member_count integer := 0;
begin
  if p_customer_id is null or p_group_id is null or p_contact_ids is null
     or cardinality(p_contact_ids) = 0 or cardinality(p_contact_ids) > 1000 then
    raise exception 'Choose between 1 and 1000 contacts.';
  end if;

  if not exists (
    select 1 from public.contact_groups g
    where g.id = p_group_id and g.customer_id = p_customer_id
  ) then
    raise exception 'Contact group does not belong to this workspace.';
  end if;

  create temporary table pg_temp.requested_contact_ids (
    contact_id uuid primary key
  ) on commit drop;

  insert into pg_temp.requested_contact_ids(contact_id)
  select distinct contact_id
  from unnest(p_contact_ids) as requested(contact_id)
  where contact_id is not null;

  select count(*) into v_requested_count from pg_temp.requested_contact_ids;
  if v_requested_count = 0 then
    raise exception 'Choose at least one valid contact.';
  end if;

  select count(*) into v_eligible_count
  from pg_temp.requested_contact_ids requested
  join public.contacts c
    on c.id = requested.contact_id
   and c.customer_id = p_customer_id;

  select count(*) into v_existing_count
  from pg_temp.requested_contact_ids requested
  join public.contacts c
    on c.id = requested.contact_id
   and c.customer_id = p_customer_id
  join public.contact_group_members member
    on member.group_id = p_group_id
   and member.contact_id = c.id;

  insert into public.contact_group_members(group_id, contact_id)
  select p_group_id, c.id
  from pg_temp.requested_contact_ids requested
  join public.contacts c
    on c.id = requested.contact_id
   and c.customer_id = p_customer_id
  on conflict (group_id, contact_id) do nothing;
  get diagnostics v_added_count = row_count;

  select count(*) into v_member_count
  from public.contact_group_members member
  where member.group_id = p_group_id;

  update public.contact_groups g
  set total_contacts = v_member_count
  where g.id = p_group_id and g.customer_id = p_customer_id;

  return query select
    v_added_count,
    v_existing_count,
    v_requested_count - v_eligible_count,
    v_member_count;
end;
$$;

create or replace function public.remove_contact_group_members_batch(
  p_customer_id uuid,
  p_group_id uuid,
  p_contact_ids uuid[]
)
returns table (
  removed_count integer,
  not_member_count integer,
  failed_count integer,
  member_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_requested_count integer := 0;
  v_eligible_count integer := 0;
  v_removed_count integer := 0;
  v_member_count integer := 0;
begin
  if p_customer_id is null or p_group_id is null or p_contact_ids is null
     or cardinality(p_contact_ids) = 0 or cardinality(p_contact_ids) > 1000 then
    raise exception 'Choose between 1 and 1000 contacts.';
  end if;

  if not exists (
    select 1 from public.contact_groups g
    where g.id = p_group_id and g.customer_id = p_customer_id
  ) then
    raise exception 'Contact group does not belong to this workspace.';
  end if;

  create temporary table pg_temp.requested_contact_ids (
    contact_id uuid primary key
  ) on commit drop;

  insert into pg_temp.requested_contact_ids(contact_id)
  select distinct contact_id
  from unnest(p_contact_ids) as requested(contact_id)
  where contact_id is not null;

  select count(*) into v_requested_count from pg_temp.requested_contact_ids;
  if v_requested_count = 0 then
    raise exception 'Choose at least one valid contact.';
  end if;

  select count(*) into v_eligible_count
  from pg_temp.requested_contact_ids requested
  join public.contacts c
    on c.id = requested.contact_id
   and c.customer_id = p_customer_id;

  delete from public.contact_group_members member
  using pg_temp.requested_contact_ids requested, public.contacts c
  where member.group_id = p_group_id
    and member.contact_id = requested.contact_id
    and c.id = requested.contact_id
    and c.customer_id = p_customer_id;
  get diagnostics v_removed_count = row_count;

  select count(*) into v_member_count
  from public.contact_group_members member
  where member.group_id = p_group_id;

  update public.contact_groups g
  set total_contacts = v_member_count
  where g.id = p_group_id and g.customer_id = p_customer_id;

  return query select
    v_removed_count,
    v_eligible_count - v_removed_count,
    v_requested_count - v_eligible_count,
    v_member_count;
end;
$$;

revoke all on function public.add_contact_group_members_batch(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.remove_contact_group_members_batch(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.add_contact_group_members_batch(uuid, uuid, uuid[]) to service_role;
grant execute on function public.remove_contact_group_members_batch(uuid, uuid, uuid[]) to service_role;

