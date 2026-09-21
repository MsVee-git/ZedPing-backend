-- D2.3 Automation Library provenance: nullable to preserve legacy rules.
ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS library_template_id text NULL,
  ADD COLUMN IF NOT EXISTS library_template_version integer NULL;

COMMENT ON COLUMN public.automations.library_template_id IS 'Version-controlled Automation Library recipe identifier; nullable for legacy rules.';
COMMENT ON COLUMN public.automations.library_template_version IS 'Automation Library recipe version; nullable for legacy rules.';