begin;
create table public.gupshup_usage_periods (
 id uuid primary key default gen_random_uuid(), customer_id uuid not null references customers(id),
 kind text not null check(kind in ('template','service','ai')),
 period_start timestamptz not null, period_end timestamptz not null,
 allowance integer not null check(allowance>=0), reserved integer not null default 0 check(reserved>=0 and reserved<=allowance),
 check(period_end>period_start), unique(customer_id,kind,period_start)
);
create table public.gupshup_usage_reservations (
 id uuid primary key, customer_id uuid not null references customers(id),
 period_id uuid not null references gupshup_usage_periods(id),
 state text not null default 'reserved' check(state in ('reserved','accepted','confirmation_required')),
 provider_message_id text, created_at timestamptz not null default now()
);
alter table public.gupshup_usage_periods enable row level security;
alter table public.gupshup_usage_reservations enable row level security;
revoke all on public.gupshup_usage_periods,public.gupshup_usage_reservations from public,anon,authenticated;
grant select,insert,update,delete on public.gupshup_usage_periods,public.gupshup_usage_reservations to service_role;
create function public.reserve_gupshup_usage(p_customer_id uuid,p_reservation_id uuid,p_kind text)
returns uuid language plpgsql security invoker set search_path=public as $$
declare period public.gupshup_usage_periods%rowtype; existing public.gupshup_usage_reservations%rowtype;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_customer_id::text || ':' || p_kind,0));
 select * into existing from gupshup_usage_reservations where id=p_reservation_id;
 if found then raise exception 'Reservation already exists; reconcile before sending'; end if;
 if (select count(*) from gupshup_usage_periods where customer_id=p_customer_id and kind=p_kind and period_start<=now() and period_end>now())<>1 then
  raise exception 'Exactly one active usage period is required'; end if;
 select * into strict period from gupshup_usage_periods where customer_id=p_customer_id and kind=p_kind and period_start<=now() and period_end>now() for update;
 if period.reserved>=period.allowance then raise exception 'Allowance exhausted'; end if;
 update gupshup_usage_periods set reserved=reserved+1 where id=period.id;
 insert into gupshup_usage_reservations(id,customer_id,period_id) values(p_reservation_id,p_customer_id,period.id);
 return p_reservation_id;
end $$;
revoke all on function public.reserve_gupshup_usage(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.reserve_gupshup_usage(uuid,uuid,text) to service_role;
commit;
