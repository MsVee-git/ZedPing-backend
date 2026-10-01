-- Retain inbound_media for the already-live inbound path. Outbound attachments
-- get their own opaque metadata field so prior messages and snapshots remain
-- untouched. Meta media IDs are never returned to browser clients.
alter table public.messages
  add column if not exists outbound_media jsonb;

alter table public.messages
  drop constraint if exists messages_inbound_media_shape_check;

alter table public.messages
  add constraint messages_inbound_media_shape_check check (
    inbound_media is null or (
      direction = 'inbound'
      and jsonb_typeof(inbound_media) = 'object'
      and inbound_media ? 'type'
      and (
        (inbound_media->>'type' in ('image', 'document') and inbound_media ? 'media_id')
        or inbound_media->>'type' = 'location'
      )
    )
  );

alter table public.messages
  drop constraint if exists messages_outbound_media_shape_check;

alter table public.messages
  add constraint messages_outbound_media_shape_check check (
    outbound_media is null or (
      direction = 'outbound'
      and jsonb_typeof(outbound_media) = 'object'
      and outbound_media ? 'type'
      and (
        (outbound_media->>'type' in ('image', 'document') and outbound_media ? 'media_id')
        or outbound_media->>'type' = 'location'
      )
    )
  );
