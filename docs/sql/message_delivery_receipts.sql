-- Additive release SQL; applied with Supabase migration API because the local CLI is unavailable.
create table public.message_delivery_events (
 id uuid primary key default gen_random_uuid(),
 customer_id uuid not null references public.customers(id) on delete cascade,
 whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
 provider text not null check(provider in ('meta','gupshup')),
 message_id text not null check(length(message_id) between 1 and 255),
 alternate_message_id text,
 status text not null check(status in ('sent','delivered','read','failed')),
 occurred_at timestamptz not null,
 errors jsonb not null default '[]'::jsonb check(jsonb_typeof(errors)='array'),
 created_at timestamptz not null default now(),
 unique(customer_id,whatsapp_number_id,provider,message_id,status,occurred_at)
);
alter table public.message_delivery_events enable row level security;
revoke all on public.message_delivery_events from public,anon,authenticated;
grant select,insert,update,delete on public.message_delivery_events to service_role;
create index message_delivery_events_match_idx on public.message_delivery_events(customer_id,whatsapp_number_id,message_id);
create index message_delivery_events_alternate_idx on public.message_delivery_events(customer_id,whatsapp_number_id,alternate_message_id) where alternate_message_id is not null;
alter table public.messages add column delivery_receipts jsonb not null default '{}'::jsonb;
alter table public.messages add column broadcast_id uuid references public.scheduled_broadcasts(id) on delete set null;
create index messages_broadcast_receipts_idx on public.messages(customer_id,broadcast_id) where broadcast_id is not null;

-- Invoker privileges: only the trusted backend can create receipt evidence.
-- One number lock serializes receipt/message insert races; late receipts never downgrade read/delivered.
create function public.apply_message_delivery_receipts() returns trigger language plpgsql security invoker set search_path='' as $$
declare r record; evidence jsonb := '{}'::jsonb; target_status text; reason jsonb;
begin
 if new.broadcast_id is not null and not exists(select 1 from public.scheduled_broadcasts b where b.id=new.broadcast_id and b.customer_id=new.customer_id) then raise exception 'Campaign workspace mismatch'; end if;
 if current_user not in ('service_role','postgres','supabase_admin') then
  if tg_op='INSERT' then new.delivery_receipts := '{}'::jsonb;
  else
   new.delivery_receipts := old.delivery_receipts;
   if new.customer_id is distinct from old.customer_id or new.whatsapp_number_id is distinct from old.whatsapp_number_id or new.meta_message_id is distinct from old.meta_message_id or new.direction is distinct from old.direction then new.delivery_receipts := '{}'::jsonb; end if;
  end if;
  return new;
 end if;
 if new.direction <> 'outbound' or new.meta_message_id is null or new.whatsapp_number_id is null then return new; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.customer_id::text||':'||new.whatsapp_number_id::text,0));
 for r in select status,min(occurred_at) as at from public.message_delivery_events
  where customer_id=new.customer_id and whatsapp_number_id=new.whatsapp_number_id
  and (message_id=new.meta_message_id or alternate_message_id=new.meta_message_id) group by status
 loop evidence := evidence || jsonb_build_object(r.status||'_at',r.at); end loop;
 if evidence='{}'::jsonb then return new; end if;
 if evidence ? 'read_at' then target_status:='read';
 elsif evidence ? 'delivered_at' then target_status:='delivered';
 elsif evidence ? 'failed_at' then target_status:='failed';
 else target_status:='sent'; end if;
 select errors into reason from public.message_delivery_events where customer_id=new.customer_id
  and whatsapp_number_id=new.whatsapp_number_id and (message_id=new.meta_message_id or alternate_message_id=new.meta_message_id)
  and status='failed' order by occurred_at desc,id desc limit 1;
 new.delivery_receipts := evidence || jsonb_build_object('errors',coalesce(reason,'[]'::jsonb));
 new.status := target_status;
 return new;
end $$;
revoke all on function public.apply_message_delivery_receipts() from public,anon,authenticated;
grant execute on function public.apply_message_delivery_receipts() to service_role;
create trigger apply_message_delivery_receipts before insert or update on public.messages for each row execute function public.apply_message_delivery_receipts();

create function public.attach_message_delivery_event() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if not exists(select 1 from public.whatsapp_numbers n where n.id=new.whatsapp_number_id and n.customer_id=new.customer_id) then raise exception 'Receipt workspace mismatch'; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.customer_id::text||':'||new.whatsapp_number_id::text,0));
 update public.messages set status=status where customer_id=new.customer_id and whatsapp_number_id=new.whatsapp_number_id
  and direction='outbound' and (meta_message_id=new.message_id or meta_message_id=new.alternate_message_id);
 return new;
end $$;
revoke all on function public.attach_message_delivery_event() from public,anon,authenticated;
grant execute on function public.attach_message_delivery_event() to service_role;
create trigger attach_message_delivery_event after insert on public.message_delivery_events for each row execute function public.attach_message_delivery_event();
