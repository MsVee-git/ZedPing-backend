-- Run inside a transaction and roll back: no fixture contacts or sends survive.
do $$
declare
 mapping public.gupshup_connection_mappings%rowtype;
 conv public.conversations%rowtype;
 event_id uuid;
 message_id text;
 sender text := '1990' || lpad((floor(random()*100000000))::text,8,'0');
 scenario text;
 previous_unread integer;
begin
 select * into strict mapping from public.gupshup_connection_mappings where link_state='linked' and app_id is not null limit 1;
 foreach scenario in array array['new','resolved','human','needs_attention','duplicate'] loop
  message_id := 'routing-regression-' || gen_random_uuid()::text;
  if scenario='resolved' then
   update public.conversations set status='resolved',control_mode='human' where id=conv.id;
  elsif scenario='human' then
   update public.conversations set status='open',control_mode='human' where id=conv.id;
  elsif scenario='needs_attention' then
   update public.conversations set status='needs_attention',control_mode='needs_attention' where id=conv.id;
  elsif scenario='duplicate' then
   select unread_count into previous_unread from public.conversations where id=conv.id;
   select meta_message_id into strict message_id from public.messages where conversation_id=conv.id order by created_at desc limit 1;
  end if;
  insert into public.gupshup_webhook_events(customer_id,whatsapp_number_id,app_id,event_key,event_type,payload,created_at)
  values(mapping.customer_id,mapping.whatsapp_number_id,mapping.app_id,'regression:'||gen_random_uuid()::text,'message',jsonb_build_object('message_id',message_id,'from',sender,'body','Hello'),'1970-01-01') returning id into event_id;
  if public.process_next_gupshup_text_event() is distinct from event_id then raise exception 'Test event was not selected'; end if;
  select c.* into strict conv from public.conversations c join public.contacts p on c.contact_id=p.id where c.customer_id=mapping.customer_id and c.whatsapp_number_id=mapping.whatsapp_number_id and p.phone_e164='+'||sender;
  if scenario in ('new','resolved') and (conv.status<>'open' or conv.control_mode<>'automation') then raise exception 'Automation routing failed: %',scenario; end if;
  if scenario='human' and conv.control_mode<>'human' then raise exception 'Human control changed'; end if;
  if scenario='needs_attention' and (conv.status<>'needs_attention' or conv.control_mode<>'needs_attention') then raise exception 'Handoff changed'; end if;
  if scenario='duplicate' and conv.unread_count<>previous_unread then raise exception 'Duplicate changed unread count'; end if;
 end loop;
end $$;
select 'passed: new chat, resolved chat, human control, handoff, duplicate' as regression_result;
