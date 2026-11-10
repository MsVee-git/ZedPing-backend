alter table public.messages
  add column broadcast_send_spec jsonb,
  add column broadcast_rejection_code integer,
  add column broadcast_retry_id uuid;

create function public.protect_broadcast_retry_fields()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.broadcast_send_spec is not null or new.broadcast_rejection_code is not null or new.broadcast_retry_id is not null then
      raise insufficient_privilege using message = 'Broadcast send evidence is managed by the messaging service';
    end if;
  elsif new.broadcast_send_spec is distinct from old.broadcast_send_spec
    or new.broadcast_rejection_code is distinct from old.broadcast_rejection_code
    or new.broadcast_retry_id is distinct from old.broadcast_retry_id
    or ((old.broadcast_id is not null or new.broadcast_id is not null or old.broadcast_retry_id is not null) and
      (new.to_number, new.whatsapp_number_id, new.customer_id, new.broadcast_id, new.direction, new.meta_message_id)
      is distinct from
      (old.to_number, old.whatsapp_number_id, old.customer_id, old.broadcast_id, old.direction, old.meta_message_id)) then
    raise insufficient_privilege using message = 'Broadcast send evidence is managed by the messaging service';
  end if;
  return new;
end;
$$;
revoke all on function public.protect_broadcast_retry_fields() from public, anon, authenticated;
grant execute on function public.protect_broadcast_retry_fields() to service_role;
create trigger protect_broadcast_retry_fields
  before insert or update on public.messages
  for each row execute function public.protect_broadcast_retry_fields();
