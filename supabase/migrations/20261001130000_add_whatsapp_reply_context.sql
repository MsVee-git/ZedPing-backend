-- A reply is always anchored to an internal message. The original external
-- Meta ID remains server-side in messages.meta_message_id for resolution.
begin;

alter table public.messages
  add column if not exists reply_to_message_id uuid references public.messages(id) on delete set null;

alter table public.messages
  add column if not exists reply_context_meta_id text;

alter table public.messages
  drop constraint if exists messages_reply_context_meta_id_check;

alter table public.messages
  add constraint messages_reply_context_meta_id_check check (
    reply_context_meta_id is null or reply_context_meta_id ~ '^[A-Za-z0-9._:-]{1,255}$'
  );

create index if not exists messages_reply_to_message_id_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

drop trigger if exists messages_reply_context_workspace_integrity on public.messages;

create or replace function public.assert_message_reply_context_workspace()
returns trigger
language plpgsql
set search_path = public
as $reply_context$
declare
  parent_message public.messages%rowtype;
begin
  if new.reply_to_message_id is null then return new; end if;
  select * into parent_message from public.messages where id = new.reply_to_message_id;
  if not found
    or parent_message.customer_id is distinct from new.customer_id
    or parent_message.whatsapp_number_id is distinct from new.whatsapp_number_id
    or parent_message.conversation_id is distinct from new.conversation_id then
    raise exception 'Reply context must reference a message in the same workspace, WhatsApp number, and conversation';
  end if;
  return new;
end;
$reply_context$;

revoke all on function public.assert_message_reply_context_workspace() from public;

create trigger messages_reply_context_workspace_integrity
before insert or update of reply_to_message_id, customer_id, whatsapp_number_id, conversation_id on public.messages
for each row execute function public.assert_message_reply_context_workspace();

commit;
