alter table public.scheduled_broadcasts add column if not exists failure_reason text;
alter table public.scheduled_broadcasts drop constraint scheduled_broadcasts_status_check;
alter table public.scheduled_broadcasts add constraint scheduled_broadcasts_status_check check (status in ('pending','sending','completed','failed','cancelled'));
create table public.campaign_schedule_jobs (
 id uuid primary key references public.scheduled_broadcasts(id) on delete cascade,
 customer_id uuid not null references public.customers(id) on delete cascade,
 scheduled_at timestamptz not null,
 state text not null default 'queued' check(state in ('queued','running','done','failed','cancelled')),
 spec jsonb not null, recipients jsonb not null,
 media_path text, media_type text, media_name text,
 started_at timestamptz, heartbeat_at timestamptz, finished_at timestamptz, failure_reason text,
 created_at timestamptz not null default now()
);
create index campaign_schedule_due on public.campaign_schedule_jobs(scheduled_at) where state='queued';
create index campaign_schedule_workspace on public.campaign_schedule_jobs(customer_id);
alter table public.campaign_schedule_jobs enable row level security;
revoke all on public.campaign_schedule_jobs from public,anon,authenticated;
grant all on public.campaign_schedule_jobs to service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('campaign-media','campaign-media',false,10485760,array['image/jpeg','image/png','application/pdf']) on conflict(id) do nothing;

-- The cancellation and saved activity change together, racing the worker's claim on state.
create function public.cancel_scheduled_campaign(p_customer_id uuid,p_id uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare job public.campaign_schedule_jobs;
begin
 update public.campaign_schedule_jobs set state='cancelled',finished_at=now()
 where id=p_id and customer_id=p_customer_id and state='queued' returning * into job;
 if not found then return null; end if;
 update public.scheduled_broadcasts set status='cancelled',completed_at=now() at time zone 'UTC'
 where id=p_id and customer_id=p_customer_id;
 return jsonb_build_object('id',job.id,'media_path',job.media_path);
end $$;
revoke all on function public.cancel_scheduled_campaign(uuid,uuid) from public,anon,authenticated;
grant execute on function public.cancel_scheduled_campaign(uuid,uuid) to service_role;
