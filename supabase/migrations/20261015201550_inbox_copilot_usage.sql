-- Server-only usage accounting. No conversation bodies or generated replies are stored.
create table public.inbox_copilot_requests (
  id uuid primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  actor_user_id uuid not null,
  state text not null default 'reserved' check (state in ('reserved','completed','failed')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  created_at timestamptz not null default now()
);
create index inbox_copilot_requests_workspace_created on public.inbox_copilot_requests(customer_id,created_at);
alter table public.inbox_copilot_requests enable row level security;
revoke all on public.inbox_copilot_requests from anon, authenticated;
grant select,insert,update on public.inbox_copilot_requests to service_role;

create function public.reserve_inbox_copilot_request(p_customer_id uuid,p_user_id uuid,p_request_id uuid,p_limit integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare used integer;
begin
  if p_limit is null or p_limit < 1 or p_limit > 10000 then raise exception 'Invalid request limit'; end if;
  perform pg_advisory_xact_lock(hashtextextended('inbox-copilot:' || p_customer_id::text,0));
  select count(*) into used from public.inbox_copilot_requests
    where customer_id=p_customer_id and created_at >= date_trunc('month',now() at time zone 'UTC') at time zone 'UTC';
  if used >= p_limit then raise exception 'Monthly request limit reached'; end if;
  if (select count(*) from public.inbox_copilot_requests where customer_id=p_customer_id and created_at > now()-interval '1 minute') >= 3
    then raise exception 'Please wait before requesting again'; end if;
  insert into public.inbox_copilot_requests(id,customer_id,actor_user_id) values(p_request_id,p_customer_id,p_user_id);
  return jsonb_build_object('remaining',p_limit-used-1);
end;
$$;
revoke all on function public.reserve_inbox_copilot_request(uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_inbox_copilot_request(uuid,uuid,uuid,integer) to service_role;
