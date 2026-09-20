-- IANA identifiers can have more than one slash; backend validation uses Intl instead.
alter table public.workspace_automation_settings drop constraint if exists workspace_automation_settings_timezone_check;
