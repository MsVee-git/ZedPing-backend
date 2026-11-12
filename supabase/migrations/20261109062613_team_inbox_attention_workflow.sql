-- The workflow fields are separate from WhatsApp handling and message delivery.
alter table public.conversations
  add column callback_due_at timestamptz,
  add column booked_at timestamptz,
  add column paid_at timestamptz,
  add column awaiting_reply boolean generated always as (
    status = 'open'
    and last_inbound_at is not null
    and (last_outbound_at is null or last_inbound_at > last_outbound_at)
  ) stored;

notify pgrst, 'reload schema';
