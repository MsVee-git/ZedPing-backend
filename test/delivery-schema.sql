create role anon; create role authenticated; create role service_role bypassrls;
create table public.customers(id uuid primary key);
create table public.whatsapp_numbers(id uuid primary key,customer_id uuid);
create table public.scheduled_broadcasts(id uuid primary key,customer_id uuid);
create table public.messages(id uuid primary key default gen_random_uuid(),customer_id uuid,whatsapp_number_id uuid,direction text,status text,meta_message_id text);
grant usage on schema public to service_role,authenticated;
grant all on public.customers,public.whatsapp_numbers,public.scheduled_broadcasts,public.messages to service_role;
grant select,insert,update on public.messages to authenticated;
grant select on public.scheduled_broadcasts to authenticated;
