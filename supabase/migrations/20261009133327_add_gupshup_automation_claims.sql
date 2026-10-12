begin;
alter table public.gupshup_webhook_events add column automation_state text not null default 'pending'
 check(automation_state in ('pending','processing','complete','confirmation_required'));
create index gupshup_automation_pending on public.gupshup_webhook_events(created_at)
 where event_type='message' and processing_state='complete' and automation_state='pending';
commit;
