-- Backend-only search; the caller supplies its authenticated workspace, never a browser workspace ID.
create or replace function public.search_inbox_conversations(p_customer_id uuid,p_query text)
returns setof public.conversations language sql stable security invoker set search_path = '' as $$
 select c.* from public.conversations c
 where c.customer_id=p_customer_id
 and length(btrim(p_query)) between 2 and 120
 and (
 exists(select 1 from public.contacts ct where ct.id=c.contact_id and ct.customer_id=p_customer_id
   and (strpos(lower(coalesce(ct.name,'')),lower(btrim(p_query)))>0 or strpos(coalesce(ct.phone_number,''),btrim(p_query))>0))
 or exists(select 1 from public.messages m where m.conversation_id=c.id and m.customer_id=p_customer_id
   and strpos(lower(coalesce(m.message_body,'')),lower(btrim(p_query)))>0)
 );
$$;
revoke all on function public.search_inbox_conversations(uuid,text) from public,anon,authenticated;
grant execute on function public.search_inbox_conversations(uuid,text) to service_role;
