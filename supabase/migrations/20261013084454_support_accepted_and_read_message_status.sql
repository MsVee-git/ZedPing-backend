begin;
alter table public.messages drop constraint messages_status_check;
alter table public.messages add constraint messages_status_check check (status in ('accepted','sent','delivered','read','failed','received'));
commit;
