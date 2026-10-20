begin;
create table public.landing_page_leads (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null unique,
 name text not null check(length(name) between 2 and 100),
 business_name text not null check(length(business_name) between 2 and 160),
 phone text not null check(phone ~ '^[1-9][0-9]{6,14}$'),
 email text check(length(email)<=254), interest text not null check(interest in ('demo','starter','business','pro','help')),
 message text not null default '' check(length(message)<=2000),
 consent_at timestamptz not null default now(), consent_version text not null default 'enquiry-v1',
 utm_source text, utm_medium text, utm_campaign text,
 status text not null default 'new' check(status in ('new','contacted','qualified','closed')),
 created_at timestamptz not null default now()
);
create index landing_leads_recent on public.landing_page_leads(created_at desc);
create index landing_leads_phone_recent on public.landing_page_leads(phone,created_at desc);
alter table public.landing_page_leads enable row level security;
revoke all on public.landing_page_leads from public, anon, authenticated;
grant select,insert,update,delete on public.landing_page_leads to service_role;
create function public.capture_landing_lead(p_lead jsonb) returns boolean
language plpgsql security invoker set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('landing-leads',0));
 if exists(select 1 from landing_page_leads where submission_id=(p_lead->>'submission_id')::uuid) then return true; end if;
 if (select count(*) from landing_page_leads where phone=p_lead->>'phone' and created_at>now()-interval '1 hour')>=3
 or (select count(*) from landing_page_leads where created_at>now()-interval '10 minutes')>=100 then return false; end if;
 insert into landing_page_leads(submission_id,name,business_name,phone,email,interest,message,utm_source,utm_medium,utm_campaign)
 values((p_lead->>'submission_id')::uuid,p_lead->>'name',p_lead->>'business_name',p_lead->>'phone',p_lead->>'email',p_lead->>'interest',p_lead->>'message',p_lead->>'utm_source',p_lead->>'utm_medium',p_lead->>'utm_campaign');
 return true;
end $$;
revoke all on function public.capture_landing_lead(jsonb) from public,anon,authenticated;
grant execute on function public.capture_landing_lead(jsonb) to service_role;
commit;
