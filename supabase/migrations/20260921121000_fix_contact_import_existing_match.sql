create or replace function public.execute_contact_import(
  p_customer_id uuid, p_importing_user_id uuid, p_group_id uuid, p_filename text,
  p_source_label text, p_total_rows integer, p_skipped_count integer, p_entries jsonb
)
returns table (import_id uuid, created_count integer, existing_count integer, skipped_count integer, group_members_added integer)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_import_id uuid; v_row record; v_contact_id uuid; v_created integer := 0;
  v_existing integer := 0; v_members_added integer := 0; v_member_rows integer := 0;
begin
  if p_customer_id is null or p_importing_user_id is null or p_total_rows < 0 or p_skipped_count < 0 or jsonb_typeof(p_entries) <> 'array' then
    raise exception 'Invalid contact import request';
  end if;
  if p_group_id is not null and not exists (select 1 from public.contact_groups where id=p_group_id and customer_id=p_customer_id) then
    raise exception 'Selected contact group does not belong to this workspace';
  end if;
  insert into public.contact_imports(customer_id, importing_user_id, selected_group_id, filename, source_label, total_rows, skipped_count, acknowledgement_at)
  values(p_customer_id,p_importing_user_id,p_group_id,nullif(btrim(p_filename),''),nullif(btrim(p_source_label),''),p_total_rows,p_skipped_count,now())
  returning id into v_import_id;

  for v_row in select * from jsonb_to_recordset(p_entries)
    as x(phone_e164 text, name text, email text, existing_contact_id uuid)
  loop
    if v_row.phone_e164 is null or v_row.phone_e164 !~ '^\\+[1-9][0-9]{7,14}$' then
      raise exception 'Validated import entry has an invalid phone number';
    end if;
    v_contact_id := null;
    if v_row.existing_contact_id is not null then
      select c.id into v_contact_id from public.contacts c
      where c.id=v_row.existing_contact_id and c.customer_id=p_customer_id
      for update;
    end if;
    if v_contact_id is null then
      select c.id into v_contact_id from public.contacts c
      where c.customer_id=p_customer_id and (c.phone_e164=v_row.phone_e164 or c.phone_number=v_row.phone_e164)
      order by c.created_at asc, c.id asc limit 1 for update;
    end if;
    if v_contact_id is not null then
      update public.contacts c set
        name=case when btrim(coalesce(c.name,''))='' and btrim(coalesce(v_row.name,''))<>'' then btrim(v_row.name) else c.name end,
        email=case when nullif(btrim(coalesce(c.email,'')),'') is null and nullif(btrim(coalesce(v_row.email,'')),'') is not null then lower(btrim(v_row.email)) else c.email end,
        phone_e164=coalesce(c.phone_e164,v_row.phone_e164)
      where c.id=v_contact_id and c.customer_id=p_customer_id;
      v_existing:=v_existing+1;
    else
      begin
        insert into public.contacts(customer_id,name,phone_number,phone_e164,email,source,import_batch_id,custom_fields)
        values(p_customer_id,coalesce(nullif(btrim(v_row.name),''),''),v_row.phone_e164,v_row.phone_e164,nullif(lower(btrim(v_row.email)),''),'import',v_import_id,'{}'::jsonb)
        returning id into v_contact_id;
        v_created:=v_created+1;
      exception when unique_violation then
        select c.id into v_contact_id from public.contacts c
        where c.customer_id=p_customer_id and c.phone_e164=v_row.phone_e164 limit 1 for update;
        if v_contact_id is null then raise; end if;
        v_existing:=v_existing+1;
      end;
    end if;
    if p_group_id is not null then
      insert into public.contact_group_members(group_id,contact_id) values(p_group_id,v_contact_id)
      on conflict(group_id,contact_id) do nothing;
      get diagnostics v_member_rows = row_count;
      if v_member_rows>0 then v_members_added:=v_members_added+1; end if;
    end if;
  end loop;
  if p_group_id is not null then
    update public.contact_groups g set total_contacts=(select count(*) from public.contact_group_members m where m.group_id=p_group_id)
    where g.id=p_group_id and g.customer_id=p_customer_id;
  end if;
  update public.contact_imports set created_count=v_created,existing_count=v_existing,group_members_added=v_members_added
  where id=v_import_id and customer_id=p_customer_id;
  return query select v_import_id,v_created,v_existing,p_skipped_count,v_members_added;
end; $$;
revoke all on function public.execute_contact_import(uuid,uuid,uuid,text,text,integer,integer,jsonb) from public, anon, authenticated;
grant execute on function public.execute_contact_import(uuid,uuid,uuid,text,text,integer,integer,jsonb) to service_role;