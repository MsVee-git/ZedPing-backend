begin;

alter table public.messages drop constraint messages_inbound_media_shape_check;
alter table public.messages add constraint messages_inbound_media_shape_check check (
  inbound_media is null or (
    direction = 'inbound' and jsonb_typeof(inbound_media) = 'object' and inbound_media ? 'type'
    and ((inbound_media->>'type' in ('image', 'document') and inbound_media ? 'media_id')
      or inbound_media->>'type' in ('location', 'audio'))
  )
);

insert into storage.buckets (id, name, public, file_size_limit)
values ('whatsapp-voice-notes', 'whatsapp-voice-notes', false, 16777216);

create table public.whatsapp_voice_note_jobs (
  message_id uuid primary key references public.messages(id) on delete cascade deferrable initially deferred,
  customer_id uuid not null,
  provider_url text,
  state text not null default 'pending' check (state in ('pending','processing','dispatching','complete')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  lease uuid
);
alter table public.whatsapp_voice_note_jobs enable row level security;
revoke all on public.whatsapp_voice_note_jobs from public, anon, authenticated;
grant select, insert, update, delete on public.whatsapp_voice_note_jobs to service_role;
create index whatsapp_voice_note_pending on public.whatsapp_voice_note_jobs (available_at, message_id)
where state <> 'complete';

create function public.queue_whatsapp_voice_note()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  insert into public.whatsapp_voice_note_jobs (message_id, customer_id, provider_url)
  values (new.id, new.customer_id, new.inbound_media->>'provider_url');
  new.inbound_media := new.inbound_media - 'provider_url';
  return new;
end $$;
revoke all on function public.queue_whatsapp_voice_note() from public, anon, authenticated;
grant execute on function public.queue_whatsapp_voice_note() to service_role;
create trigger queue_whatsapp_voice_note before insert on public.messages for each row
when (new.direction = 'inbound' and new.inbound_media->>'type' = 'audio')
execute function public.queue_whatsapp_voice_note();

create function public.claim_whatsapp_voice_note(lease_token uuid)
returns setof public.whatsapp_voice_note_jobs language sql security invoker set search_path = '' as $$
  update public.whatsapp_voice_note_jobs j
  set state = case when j.state = 'dispatching' then j.state else 'processing' end,
      attempts = j.attempts + 1, lease = lease_token, available_at = now() + interval '10 minutes'
  where j.message_id = (
    select message_id from public.whatsapp_voice_note_jobs
    where state <> 'complete' and available_at <= now()
    order by available_at, message_id for update skip locked limit 1
  )
  returning j.*;
$$;
revoke all on function public.claim_whatsapp_voice_note(uuid) from public, anon, authenticated;
grant execute on function public.claim_whatsapp_voice_note(uuid) to service_role;

create function public.update_whatsapp_voice_note(
  job_message_id uuid, lease_token uuid, next_state text, next_attempt timestamptz, audio_metadata jsonb
)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  workspace_id uuid;
begin
  update public.whatsapp_voice_note_jobs
  set state = next_state,
      available_at = case when next_state in ('processing','dispatching') then now() + interval '10 minutes' else next_attempt end,
      lease = case when next_state in ('processing','dispatching') then lease_token else null end,
      provider_url = case when next_state = 'complete' or audio_metadata->>'audio_status' = 'ready' then null else provider_url end
  where message_id = job_message_id and lease = lease_token and available_at > now()
  returning customer_id into workspace_id;
  if not found then return false; end if;
  update public.messages set inbound_media = audio_metadata - 'provider_url'
  where id = job_message_id and customer_id = workspace_id;
  if not found then return false; end if;
  if audio_metadata->>'transcription_status' = 'failed' or audio_metadata->>'response_status' = 'attention' then
    update public.conversations set status = 'needs_attention', control_mode = 'needs_attention', updated_at = now()
    where customer_id = workspace_id and id = (select conversation_id from public.messages where id = job_message_id)
      and status = 'open' and control_mode = 'automation';
  end if;
  return true;
end $$;
revoke all on function public.update_whatsapp_voice_note(uuid, uuid, text, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.update_whatsapp_voice_note(uuid, uuid, text, timestamptz, jsonb) to service_role;
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
   control_mode=case when status='resolved' and not (coalesce(e.payload->'media'->>'type','')='audio' and control_mode in ('human','needs_attention')) then 'automation' else control_mode end,
   assigned_user_id=case when status='resolved' and not (coalesce(e.payload->'media'->>'type','')='audio' and control_mode in ('human','needs_attention')) then null else assigned_user_id end
  where id=conversation_id_value;
 end if;
 select id into reply_id_value from public.messages
 where customer_id=e.customer_id and whatsapp_number_id=n.id and contact_id=contact_id_value
 and conversation_id=conversation_id_value and meta_message_id=e.payload->>'reply_to_message_id' limit 1;
 insert into public.messages(customer_id,whatsapp_number_id,contact_id,conversation_id,direction,from_number,to_number,message_body,inbound_media,status,meta_message_id,reply_to_message_id,reply_context_meta_id,ad_referral)
 values(e.customer_id,n.id,contact_id_value,conversation_id_value,'inbound',e.payload->>'from',n.phone_number,e.payload->>'body',nullif(e.payload->'media','null'::jsonb),'received',e.payload->>'message_id',reply_id_value,e.payload->>'reply_to_message_id',nullif(e.payload->'ad_referral','null'::jsonb));
 update public.gupshup_webhook_events set processing_state='complete', automation_state=case when e.payload->'media'->>'type'='audio' then 'complete' else automation_state end where id=e.id;
 return e.id;
end $$;
revoke all on function public.process_next_gupshup_text_event() from public,anon,authenticated;
grant execute on function public.process_next_gupshup_text_event() to service_role;


create function public.persist_meta_whatsapp_voice_note(
  phone_id text, waba_id text, sender text, provider_message_id text,
  audio_metadata jsonb, sender_name text, reply_id text, referral jsonb
)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  number public.whatsapp_numbers%rowtype;
  contact_id_value uuid;
  conversation_id_value uuid;
  reply_id_value uuid;
begin
  select * into number from public.whatsapp_numbers
  where phone_number_id = phone_id and status = 'connected'
    and (waba_id is null or whatsapp_business_account_id = waba_id);
  if not found then return; end if;

  perform pg_advisory_xact_lock(hashtextextended(number.customer_id::text || ':' || sender, 0));
  insert into public.inbound_webhook_events(customer_id, whatsapp_number_id, meta_message_id)
  values(number.customer_id, number.id, provider_message_id)
  on conflict (whatsapp_number_id, meta_message_id) do nothing;
  if not found then return; end if;

  select id into contact_id_value from public.contacts where customer_id = number.customer_id
    and (phone_number = sender or phone_e164 = '+' || sender) limit 1;
  if not found then
    insert into public.contacts(customer_id, name, phone_number, phone_e164, source, custom_fields)
    values(number.customer_id, left(coalesce(sender_name, ''), 128), '+' || sender, '+' || sender, 'whatsapp', '{}')
    returning id into contact_id_value;
  elsif coalesce(sender_name, '') <> '' then
    update public.contacts set name = left(sender_name,128)
    where id = contact_id_value and coalesce(btrim(name), '') = '';
  end if;

  select id into conversation_id_value from public.conversations
  where customer_id = number.customer_id and whatsapp_number_id = number.id and contact_id = contact_id_value
  order by updated_at desc limit 1 for update;
  if not found then
    insert into public.conversations(customer_id, whatsapp_number_id, contact_id, status, control_mode, unread_count, last_message_at, last_inbound_at)
    values(number.customer_id, number.id, contact_id_value, 'open', 'automation', 1, now(), now())
    returning id into conversation_id_value;
  else
    update public.conversations set unread_count = coalesce(unread_count,0)+1,
      status = case when status = 'resolved' then 'open' else status end,
      last_message_at = now(), last_inbound_at = now(), updated_at = now()
    where id = conversation_id_value;
  end if;

  select id into reply_id_value from public.messages where customer_id = number.customer_id
    and whatsapp_number_id = number.id and conversation_id = conversation_id_value
    and meta_message_id = reply_id limit 1;
  insert into public.messages(customer_id, whatsapp_number_id, contact_id, conversation_id, direction, from_number, to_number,
    message_body, inbound_media, status, meta_message_id, reply_to_message_id, reply_context_meta_id, ad_referral)
  values(number.customer_id, number.id, contact_id_value, conversation_id_value, 'inbound', sender, number.phone_number,
    '[Voice note]', audio_metadata, 'received', provider_message_id, reply_id_value, reply_id, referral);
end $$;
revoke all on function public.persist_meta_whatsapp_voice_note(text, text, text, text, jsonb, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.persist_meta_whatsapp_voice_note(text, text, text, text, jsonb, text, text, jsonb) to service_role;

commit;
