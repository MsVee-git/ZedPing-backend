-- Bounded, server-owned state for an in-progress configured commercial action.
-- It is deliberately separate from the customer transcript, which remains a
-- record of messages rather than the authoritative workflow state.
alter table public.ai_agent_sessions
  add column if not exists commercial_context jsonb;

alter table public.ai_agent_sessions
  drop constraint if exists ai_agent_sessions_commercial_context_object_check;
alter table public.ai_agent_sessions
  add constraint ai_agent_sessions_commercial_context_object_check
  check (commercial_context is null or jsonb_typeof(commercial_context) = 'object');
