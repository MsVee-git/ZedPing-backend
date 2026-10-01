-- Meta media IDs are opaque references, never public URLs. The authenticated
-- application route resolves them only after workspace/conversation checks.
alter table public.messages
  add column if not exists inbound_media jsonb;

alter table public.messages
  drop constraint if exists messages_inbound_media_shape_check;

alter table public.messages
  add constraint messages_inbound_media_shape_check check (
    inbound_media is null or (
      direction = 'inbound'
      and jsonb_typeof(inbound_media) = 'object'
      and inbound_media ? 'type'
      and inbound_media ? 'media_id'
    )
  );
