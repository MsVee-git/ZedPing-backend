begin;
alter table public.messages add column if not exists ad_referral jsonb;
alter table public.contact_groups add column if not exists ad_source_type text;
alter table public.contact_groups add column if not exists ad_source_id text;
create unique index if not exists contact_groups_ad_source_key on public.contact_groups(customer_id,ad_source_type,ad_source_id) where ad_source_type is not null;

create table public.whatsapp_ad_referrals (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete cascade,
 whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
 contact_id uuid not null references public.contacts(id) on delete cascade,
 message_id uuid not null unique references public.messages(id) on delete cascade,
 source_type text not null check(source_type in ('ad','post')),
 source_id text,headline text,body text,source_url text,ctwa_clid text,
 created_at timestamptz not null default now()
);
create index whatsapp_ad_referrals_customer_contact_idx on public.whatsapp_ad_referrals(customer_id,contact_id,created_at desc);
alter table public.whatsapp_ad_referrals enable row level security;
revoke all on public.whatsapp_ad_referrals from public,anon,authenticated;
grant all on public.whatsapp_ad_referrals to service_role;
-- Raw click identifiers are not exposed through browser roles or public APIs.

create or replace function public.ensure_whatsapp_ad_group(p_customer_id uuid,p_type text,p_source_id text,p_name text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare group_id_value uuid;
begin
 if coalesce(p_type,'') not in ('all','ad','post') or p_source_id is null then raise exception 'Invalid ad group';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text||':ad-groups',0));
 select id into group_id_value from public.contact_groups where customer_id=p_customer_id and ad_source_type=p_type and ad_source_id=p_source_id;
 if group_id_value is null then
  begin
   insert into public.contact_groups(customer_id,name,description,ad_source_type,ad_source_id)
   values(p_customer_id,left(p_name,80),'Automatically collected WhatsApp ad enquiries',p_type,p_source_id) returning id into group_id_value;
  exception when unique_violation then
   -- Preserve a manually created same-name group rather than mixing its audience.
   insert into public.contact_groups(customer_id,name,description,ad_source_type,ad_source_id)
   values(p_customer_id,left(p_name,60)||' · '||left(gen_random_uuid()::text,8),'Automatically collected WhatsApp ad enquiries',p_type,p_source_id) returning id into group_id_value;
  end;
 end if;
 return group_id_value;
end $$;
revoke all on function public.ensure_whatsapp_ad_group(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.ensure_whatsapp_ad_group(uuid,text,text,text) to service_role;

create or replace function public.capture_whatsapp_ad_referral()
returns trigger language plpgsql security invoker set search_path=public as $$
declare r jsonb;source_kind text;source_identifier text;group_id_value uuid;ad_group_id uuid;
begin
 r=new.ad_referral;
 if new.direction<>'inbound' or jsonb_typeof(r) is distinct from 'object' or coalesce(r->>'source_type','') not in ('ad','post') then return new;end if;
 source_kind=r->>'source_type';
 source_identifier=case when r->>'source_id' ~ '^[0-9]{5,32}$' then r->>'source_id' else null end;
 if source_identifier is null and coalesce(r->>'ctwa_clid','') !~ '^[A-Za-z0-9_-]{1,512}$' then return new;end if;
 if not exists(select 1 from public.contacts where id=new.contact_id and customer_id=new.customer_id)
 or not exists(select 1 from public.whatsapp_numbers where id=new.whatsapp_number_id and customer_id=new.customer_id) then raise exception 'Ad referral workspace mismatch';end if;
 insert into public.whatsapp_ad_referrals(customer_id,whatsapp_number_id,contact_id,message_id,source_type,source_id,headline,body,source_url,ctwa_clid)
 values(new.customer_id,new.whatsapp_number_id,new.contact_id,new.id,source_kind,source_identifier,left(r->>'headline',256),left(r->>'body',3000),left(r->>'source_url',2048),left(r->>'ctwa_clid',512)) on conflict(message_id) do nothing;
 group_id_value=public.ensure_whatsapp_ad_group(new.customer_id,'all','all','WhatsApp ad enquiries');
 insert into public.contact_group_members(group_id,contact_id) values(group_id_value,new.contact_id) on conflict(group_id,contact_id) do nothing;
 update public.contact_groups set total_contacts=(select count(*) from public.contact_group_members where group_id=group_id_value),updated_at=now() where id=group_id_value;
 if source_identifier is not null then
  ad_group_id=public.ensure_whatsapp_ad_group(new.customer_id,source_kind,source_identifier,'Ad enquiries · '||left(coalesce(nullif(r->>'headline',''),'WhatsApp'),24)||' ['||source_identifier||']');
  insert into public.contact_group_members(group_id,contact_id) values(ad_group_id,new.contact_id) on conflict(group_id,contact_id) do nothing;
  update public.contact_groups set total_contacts=(select count(*) from public.contact_group_members where group_id=ad_group_id),updated_at=now() where id=ad_group_id;
 end if;
 return new;
end $$;
revoke all on function public.capture_whatsapp_ad_referral() from public,anon,authenticated;
grant execute on function public.capture_whatsapp_ad_referral() to service_role;
create trigger messages_capture_whatsapp_ad_referral after insert or update of ad_referral on public.messages
 for each row when (new.ad_referral is not null) execute function public.capture_whatsapp_ad_referral();

create or replace function public.process_next_gupshup_text_event()
returns uuid language plpgsql security invoker set search_path = public as $$
declare
 e public.gupshup_webhook_events%rowtype;
 n public.whatsapp_numbers%rowtype;
 contact_id_value uuid;
 conversation_id_value uuid;
 reply_id_value uuid;
 claim_id_value uuid;
begin
 select * into e from public.gupshup_webhook_events
 where processing_state = 'pending' and event_type = 'message'
 order by created_at, id for update skip locked limit 1;
 if not found then return null; end if;
 select * into strict n from public.whatsapp_numbers
 where id=e.whatsapp_number_id and customer_id=e.customer_id;
 if not exists(select 1 from public.gupshup_connection_mappings
  where app_id=e.app_id and whatsapp_number_id=n.id and customer_id=e.customer_id and link_state='linked')
 then raise exception 'Invalid Gupshup event mapping'; end if;
 -- Serialize this customer's contact/conversation creation across worker processes.
 perform pg_advisory_xact_lock(hashtextextended(e.customer_id::text || ':' || (e.payload->>'from'),0));
 if exists(select 1 from public.messages where customer_id=e.customer_id and whatsapp_number_id=n.id
  and direction='inbound' and meta_message_id=e.payload->>'message_id') then
  update public.messages set ad_referral=e.payload->'ad_referral' where customer_id=e.customer_id and whatsapp_number_id=n.id and direction='inbound' and meta_message_id=e.payload->>'message_id' and ad_referral is null and jsonb_typeof(e.payload->'ad_referral')='object';
  update public.gupshup_webhook_events set processing_state='complete',automation_state='complete' where id=e.id;
  return e.id;
 end if;
 insert into public.inbound_webhook_events(customer_id,whatsapp_number_id,meta_message_id)
 values(e.customer_id,n.id,e.payload->>'message_id') on conflict(whatsapp_number_id,meta_message_id) do nothing returning id into claim_id_value;
 if claim_id_value is null then
  update public.gupshup_webhook_events set processing_state='complete',automation_state='complete' where id=e.id;
  return e.id;
 end if;
 select id into contact_id_value from public.contacts where customer_id=e.customer_id
 and (phone_number=e.payload->>'from' or phone_e164='+' || (e.payload->>'from')) limit 1;
 if contact_id_value is null then
  insert into public.contacts(customer_id,name,phone_number,phone_e164,source,custom_fields)
  values(e.customer_id,left(coalesce(e.payload->>'profile_name',''),128),'+' || (e.payload->>'from'),'+' || (e.payload->>'from'),'whatsapp','{}') returning id into contact_id_value;
 end if;
 update public.contacts set name=left(e.payload->>'profile_name',128) where id=contact_id_value and customer_id=e.customer_id and coalesce(btrim(name),'')='' and coalesce(e.payload->>'profile_name','')<>'';
 if upper(regexp_replace(trim(e.payload->>'body'), '\s+', ' ', 'g')) in ('STOP','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT') then
  update public.contacts set marketing_opted_out=true,marketing_opted_out_at=now(),marketing_opt_out_source='whatsapp_stop' where id=contact_id_value and customer_id=e.customer_id;
 end if;
 select id into conversation_id_value from public.conversations
 where customer_id=e.customer_id and whatsapp_number_id=n.id and contact_id=contact_id_value
 order by updated_at desc limit 1 for update;
 if conversation_id_value is null then
  -- New conversations must reach the automation worker. Human handoffs remain unchanged.
  insert into public.conversations(customer_id,whatsapp_number_id,contact_id,status,control_mode,unread_count,last_message_at,last_inbound_at)
  values(e.customer_id,n.id,contact_id_value,'open','automation',1,now(),now()) returning id into conversation_id_value;
 else
  update public.conversations set unread_count=coalesce(unread_count,0)+1,last_message_at=now(),last_inbound_at=now(),updated_at=now(),
   status=case when status='resolved' then 'open' else status end,
   control_mode=case when status='resolved' then 'automation' else control_mode end,
   assigned_user_id=case when status='resolved' then null else assigned_user_id end
  where id=conversation_id_value;
 end if;
 select id into reply_id_value from public.messages
 where customer_id=e.customer_id and whatsapp_number_id=n.id and contact_id=contact_id_value
 and conversation_id=conversation_id_value and meta_message_id=e.payload->>'reply_to_message_id' limit 1;
 insert into public.messages(customer_id,whatsapp_number_id,contact_id,conversation_id,direction,from_number,to_number,message_body,inbound_media,status,meta_message_id,reply_to_message_id,reply_context_meta_id,ad_referral)
 values(e.customer_id,n.id,contact_id_value,conversation_id_value,'inbound',e.payload->>'from',n.phone_number,e.payload->>'body',nullif(e.payload->'media','null'::jsonb),'received',e.payload->>'message_id',reply_id_value,e.payload->>'reply_to_message_id',nullif(e.payload->'ad_referral','null'::jsonb));
 update public.gupshup_webhook_events set processing_state='complete' where id=e.id;
 return e.id;
end $$;
revoke all on function public.process_next_gupshup_text_event() from public,anon,authenticated;
grant execute on function public.process_next_gupshup_text_event() to service_role;

commit;
