begin;
do $$
declare
 m public.gupshup_connection_mappings%rowtype;
 c public.conversations%rowtype;
 eid uuid; mid text; processed uuid; claim uuid; saved uuid; previous_unread integer;
 sender text := '1990'||lpad((floor(random()*100000000))::text,8,'0');
 adid text := '9'||lpad((floor(random()*1000000000000))::text,12,'0');
 scenario text;
begin
 select * into strict m from public.gupshup_connection_mappings where link_state='linked' and app_id is not null limit 1;
 foreach scenario in array array['first','second_ad','duplicate','direct_first'] loop
  mid:='ctwa-regression-'||gen_random_uuid()::text;
  if scenario='duplicate' then
   select meta_message_id into strict mid from public.messages where conversation_id=c.id order by created_at desc,id limit 1;
   previous_unread:=c.unread_count;
  end if;
  if scenario='direct_first' then
   insert into public.inbound_webhook_events(customer_id,whatsapp_number_id,meta_message_id) values(m.customer_id,m.whatsapp_number_id,mid);
   insert into public.messages(customer_id,whatsapp_number_id,contact_id,conversation_id,direction,from_number,to_number,message_body,status,meta_message_id)
   select m.customer_id,m.whatsapp_number_id,c.contact_id,c.id,'inbound',sender,phone_number,'Ad enquiry','received',mid from public.whatsapp_numbers where id=m.whatsapp_number_id;
  end if;
  insert into public.gupshup_webhook_events(customer_id,whatsapp_number_id,app_id,event_key,event_type,payload,created_at)
  values(m.customer_id,m.whatsapp_number_id,m.app_id,'ctwa-test:'||gen_random_uuid()::text,'message',jsonb_build_object('message_id',mid,'from',sender,'body','Tell me more','profile_name','Ad Test Customer','ad_referral',jsonb_build_object('source_type','ad','source_id',adid,'headline','Menu enquiry','ctwa_clid','test_click')),'1970-01-01') returning id into eid;
  processed:=public.process_next_gupshup_text_event();
  if processed is distinct from eid then raise exception 'Wrong event processed';end if;
  select v.* into strict c from public.conversations v join public.contacts p on p.id=v.contact_id where v.customer_id=m.customer_id and v.whatsapp_number_id=m.whatsapp_number_id and p.phone_e164='+'||sender;
  select id into strict saved from public.messages where conversation_id=c.id and meta_message_id=mid;
  if not exists(select 1 from public.whatsapp_ad_referrals where message_id=saved and contact_id=c.contact_id) then raise exception 'Missing attribution';end if;
  if not exists(select 1 from public.contact_group_members gm join public.contact_groups g on g.id=gm.group_id where gm.contact_id=c.contact_id and g.customer_id=m.customer_id and g.ad_source_type='all') then raise exception 'Missing general group';end if;
  if not exists(select 1 from public.contact_group_members gm join public.contact_groups g on g.id=gm.group_id where gm.contact_id=c.contact_id and g.ad_source_id=adid) then raise exception 'Missing ad group';end if;
  if scenario='first' then
   if c.control_mode<>'automation' then raise exception 'New enquiry not automated';end if;
   if not exists(select 1 from public.contacts where id=c.contact_id and name='Ad Test Customer') then raise exception 'Profile missing';end if;
   insert into public.inbound_webhook_events(customer_id,whatsapp_number_id,meta_message_id) values(m.customer_id,m.whatsapp_number_id,mid) on conflict(whatsapp_number_id,meta_message_id) do nothing returning id into claim;
   if claim is not null then raise exception 'Meta could claim Gupshup message again';end if;
   update public.contacts set marketing_opted_out=true,name='Manual name' where id=c.contact_id;
   update public.conversations set control_mode='human' where id=c.id;
   adid:=(adid::bigint+1)::text;
  else
   if c.control_mode<>'human' then raise exception 'Human control lost';end if;
   if not exists(select 1 from public.contacts where id=c.contact_id and marketing_opted_out and name='Manual name') then raise exception 'Contact preference overwritten';end if;
  end if;
  if scenario in ('duplicate','direct_first') and not exists(select 1 from public.gupshup_webhook_events where id=eid and automation_state='complete') then raise exception 'Duplicate automation not suppressed';end if;
  if scenario='duplicate' and c.unread_count<>previous_unread then raise exception 'Duplicate unread increment';end if;
 end loop;
 if (select count(*) from public.contact_group_members gm join public.contact_groups g on g.id=gm.group_id where gm.contact_id=c.contact_id and g.ad_source_type='ad')<>2 then raise exception 'Wrong per-ad membership count';end if;
 if exists(select 1 from public.contact_groups g where g.customer_id=m.customer_id and g.ad_source_type is not null and g.total_contacts<>(select count(*) from public.contact_group_members gm where gm.group_id=g.id)) then raise exception 'Group counts mismatch';end if;
 if has_table_privilege('authenticated','public.whatsapp_ad_referrals','SELECT') or has_function_privilege('authenticated','public.ensure_whatsapp_ad_group(uuid,text,text,text)','EXECUTE') then raise exception 'Attribution permissions too broad';end if;
end $$;
select 'passed: ad capture, real groups, repeat leads, shared provider dedupe, direct-first enrichment, opt-outs, human control, restricted permissions' as result;
rollback;
