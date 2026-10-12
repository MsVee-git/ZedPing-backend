begin;
create function public.process_next_gupshup_text_event()
returns uuid language plpgsql security invoker set search_path = public as $$
declare
 e public.gupshup_webhook_events%rowtype;
 n public.whatsapp_numbers%rowtype;
 contact_id_value uuid;
 conversation_id_value uuid;
 reply_id_value uuid;
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
  update public.gupshup_webhook_events set processing_state='complete' where id=e.id;
  return e.id;
 end if;
 select id into contact_id_value from public.contacts where customer_id=e.customer_id
 and (phone_number=e.payload->>'from' or phone_e164='+' || (e.payload->>'from')) limit 1;
 if contact_id_value is null then
  insert into public.contacts(customer_id,name,phone_number,phone_e164,source,custom_fields)
  values(e.customer_id,'','+' || (e.payload->>'from'),'+' || (e.payload->>'from'),'whatsapp','{}') returning id into contact_id_value;
 end if;
 if upper(regexp_replace(trim(e.payload->>'body'), '\s+', ' ', 'g')) in ('STOP','STOP ALL','UNSUBSCRIBE','CANCEL','END','QUIT') then
  update public.contacts set marketing_opted_out=true,marketing_opted_out_at=now(),marketing_opt_out_source='whatsapp_stop' where id=contact_id_value and customer_id=e.customer_id;
 end if;
 select id into conversation_id_value from public.conversations
 where customer_id=e.customer_id and whatsapp_number_id=n.id and contact_id=contact_id_value
 order by updated_at desc limit 1 for update;
 if conversation_id_value is null then
  -- Inbox-only pilot: no AI/automation sends until provider outbox is ready.
  insert into public.conversations(customer_id,whatsapp_number_id,contact_id,status,control_mode,unread_count,last_message_at,last_inbound_at)
  values(e.customer_id,n.id,contact_id_value,'needs_attention','needs_attention',1,now(),now()) returning id into conversation_id_value;
 else
  update public.conversations set unread_count=coalesce(unread_count,0)+1,last_message_at=now(),last_inbound_at=now(),updated_at=now(),
   status=case when status='resolved' then 'needs_attention' else status end,
   control_mode=case when status='resolved' then 'needs_attention' else control_mode end
  where id=conversation_id_value;
 end if;
 select id into reply_id_value from public.messages
 where customer_id=e.customer_id and whatsapp_number_id=n.id and contact_id=contact_id_value
 and conversation_id=conversation_id_value and meta_message_id=e.payload->>'reply_to_message_id' limit 1;
 insert into public.messages(customer_id,whatsapp_number_id,contact_id,conversation_id,direction,from_number,to_number,message_body,inbound_media,status,meta_message_id,reply_to_message_id,reply_context_meta_id)
 values(e.customer_id,n.id,contact_id_value,conversation_id_value,'inbound',e.payload->>'from',n.phone_number,e.payload->>'body',nullif(e.payload->'media','null'::jsonb),'received',e.payload->>'message_id',reply_id_value,e.payload->>'reply_to_message_id');
 update public.gupshup_webhook_events set processing_state='complete' where id=e.id;
 return e.id;
end $$;
revoke all on function public.process_next_gupshup_text_event() from public,anon,authenticated;
grant execute on function public.process_next_gupshup_text_event() to service_role;
create function public.process_next_gupshup_delivery_event()
returns uuid language plpgsql security invoker set search_path = public as $$
declare e public.gupshup_webhook_events%rowtype; m public.messages%rowtype; next_status text;
begin
 select * into e from public.gupshup_webhook_events event where processing_state='pending' and event_type='status'
 and exists (select 1 from public.messages outbound where outbound.customer_id=event.customer_id
 and outbound.whatsapp_number_id=event.whatsapp_number_id and outbound.direction='outbound'
 and outbound.meta_message_id in (event.payload->>'message_id',event.payload->>'gupshup_message_id'))
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 select * into m from public.messages where customer_id=e.customer_id and whatsapp_number_id=e.whatsapp_number_id
 and direction='outbound' and meta_message_id in (e.payload->>'message_id',e.payload->>'gupshup_message_id') limit 1 for update;
 if not found then return null; end if;
 next_status=e.payload->>'status';
 -- Late events must not downgrade delivery or read confirmation.
 if next_status in ('sent','delivered','read','failed') and
  (m.status is distinct from 'read') and
  (m.status is distinct from 'delivered' or next_status='read') then
  update public.messages set status=next_status where id=m.id;
 end if;
 update public.gupshup_webhook_events set processing_state='complete' where id=e.id;
 return e.id;
end $$;
revoke all on function public.process_next_gupshup_delivery_event() from public,anon,authenticated;
grant execute on function public.process_next_gupshup_delivery_event() to service_role;
commit;
