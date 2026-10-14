begin;
insert into public.customers values('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002');
insert into public.whatsapp_numbers values('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001');
set local role service_role;
insert into public.message_delivery_events(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','meta','test-before','read','2026-10-14T10:00:00Z');
insert into public.messages(customer_id,whatsapp_number_id,direction,status,meta_message_id) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','outbound','accepted','test-before');
insert into public.message_delivery_events(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','meta','test-before','sent','2026-10-14T09:00:00Z');
insert into public.message_delivery_events(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','meta','test-before','sent','2026-10-14T09:00:00Z') on conflict do nothing;
do $$ begin
 if not exists(select 1 from public.messages where meta_message_id='test-before' and status='read' and delivery_receipts ? 'read_at' and delivery_receipts ? 'sent_at') then raise exception 'Race/out-of-order reconciliation failed'; end if;
 if (select count(*) from public.message_delivery_events where message_id='test-before')<>2 then raise exception 'Duplicate receipt'; end if;
 begin
 insert into public.message_delivery_events(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at) values('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000011','meta','test-wrong','failed',now());
 raise exception 'Cross-workspace receipt was accepted';
 exception when raise_exception then if sqlerrm <> 'Receipt workspace mismatch' then raise; end if; end;
end $$;
insert into public.messages(customer_id,whatsapp_number_id,direction,status,meta_message_id) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','outbound','accepted','test-failure');
insert into public.message_delivery_events(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at,errors) values('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000011','meta','test-failure','failed',now(),'[{"code":"131026","title":"Undeliverable"}]');
do $$ begin if not exists(select 1 from public.messages where meta_message_id='test-failure' and status='failed' and delivery_receipts->'errors'->0->>'code'='131026') then raise exception 'Failure reason missing'; end if; end $$;
reset role;
set local role authenticated;
do $$ begin
 begin perform 1 from public.message_delivery_events; raise exception 'Client can read private receipts'; exception when insufficient_privilege then null; end;
 update public.messages set delivery_receipts='{"read_at":"forged"}'::jsonb where meta_message_id='test-before';
end $$;
reset role;
do $$ begin if exists(select 1 from public.messages where delivery_receipts->>'read_at'='forged') then raise exception 'Client forged evidence'; end if; end $$;
rollback;
