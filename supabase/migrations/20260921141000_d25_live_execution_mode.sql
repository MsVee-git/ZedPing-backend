-- D2.5 Phase 3: explicitly distinguish live AI executions from private tests.
alter table public.ai_execution_events
  add column if not exists execution_mode text not null default 'live';

alter table public.ai_execution_events
  drop constraint if exists ai_execution_events_execution_mode_check;

alter table public.ai_execution_events
  add constraint ai_execution_events_execution_mode_check
  check (execution_mode in ('test', 'live'));
