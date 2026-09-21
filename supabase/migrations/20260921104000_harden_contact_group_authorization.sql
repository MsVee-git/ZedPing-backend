-- Contact group ownership and manager-only mutation hardening.
-- Replaces obsolete single-owner policies that call get_customer_id(), which is
-- intentionally not executable by authenticated clients.

drop policy if exists "contact_groups_select" on public.contact_groups;
drop policy if exists "contact_groups_insert" on public.contact_groups;
drop policy if exists "contact_groups_update" on public.contact_groups;
drop policy if exists "contact_groups_delete" on public.contact_groups;
drop policy if exists "workspace access" on public.contact_groups;

create policy "contact_groups_read_workspace"
on public.contact_groups for select to authenticated
using (public.is_workspace_member(customer_id));

create policy "contact_groups_insert_manager"
on public.contact_groups for insert to authenticated
with check (public.is_workspace_manager(customer_id));

create policy "contact_groups_update_manager"
on public.contact_groups for update to authenticated
using (public.is_workspace_manager(customer_id))
with check (public.is_workspace_manager(customer_id));

create policy "contact_groups_delete_manager"
on public.contact_groups for delete to authenticated
using (public.is_workspace_manager(customer_id));

drop policy if exists "cgm_select" on public.contact_group_members;
drop policy if exists "cgm_insert" on public.contact_group_members;
drop policy if exists "cgm_update" on public.contact_group_members;
drop policy if exists "cgm_delete" on public.contact_group_members;

create policy "cgm_select_workspace"
on public.contact_group_members for select to authenticated
using (
  exists (
    select 1
    from public.contact_groups g
    join public.contacts c on c.id = contact_group_members.contact_id
    where g.id = contact_group_members.group_id
      and g.customer_id = c.customer_id
      and public.is_workspace_member(g.customer_id)
  )
);

create policy "cgm_insert_manager_same_workspace"
on public.contact_group_members for insert to authenticated
with check (
  exists (
    select 1
    from public.contact_groups g
    join public.contacts c on c.id = contact_group_members.contact_id
    where g.id = contact_group_members.group_id
      and g.customer_id = c.customer_id
      and public.is_workspace_manager(g.customer_id)
  )
);

create policy "cgm_update_manager_same_workspace"
on public.contact_group_members for update to authenticated
using (
  exists (
    select 1
    from public.contact_groups g
    join public.contacts c on c.id = contact_group_members.contact_id
    where g.id = contact_group_members.group_id
      and g.customer_id = c.customer_id
      and public.is_workspace_manager(g.customer_id)
  )
)
with check (
  exists (
    select 1
    from public.contact_groups g
    join public.contacts c on c.id = contact_group_members.contact_id
    where g.id = contact_group_members.group_id
      and g.customer_id = c.customer_id
      and public.is_workspace_manager(g.customer_id)
  )
);

create policy "cgm_delete_manager_same_workspace"
on public.contact_group_members for delete to authenticated
using (
  exists (
    select 1
    from public.contact_groups g
    join public.contacts c on c.id = contact_group_members.contact_id
    where g.id = contact_group_members.group_id
      and g.customer_id = c.customer_id
      and public.is_workspace_manager(g.customer_id)
  )
);

create unique index if not exists contact_groups_customer_normalized_name_key
on public.contact_groups (customer_id, lower(btrim(name)));
