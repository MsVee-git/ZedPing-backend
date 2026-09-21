-- D2.5 Phase 1 follow-up: trigger functions are database-only implementation details.
revoke all on function public.enforce_ai_agent_workspace_integrity() from public, anon, authenticated;
revoke all on function public.enforce_ai_agent_session_workspace_integrity() from public, anon, authenticated;
revoke all on function public.enforce_ai_execution_event_workspace_integrity() from public, anon, authenticated;
