-- Stage D2.2: keep the workspace-manager RLS helper off the anonymous API surface.
-- The helper is required by authenticated RLS policies and server-side service operations only.

revoke all on function public.is_workspace_manager(uuid) from public;
revoke execute on function public.is_workspace_manager(uuid) from anon;
grant execute on function public.is_workspace_manager(uuid) to authenticated;
grant execute on function public.is_workspace_manager(uuid) to service_role;
