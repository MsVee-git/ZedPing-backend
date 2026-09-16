create table if not exists public.content_library_items (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 160),
  content_type text not null check (content_type in ('TEXT','DOCUMENT','IMAGE','LINK','WHATSAPP_TEMPLATE_REFERENCE')),
  text_content text, link_url text, storage_path text, original_file_name text,
  mime_type text, file_size bigint check (file_size is null or file_size >= 0),
  template_id text, template_name text, template_language text, template_status text,
  description text, created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), archived_at timestamptz,
  check ((content_type = 'TEXT' and text_content is not null and storage_path is null and link_url is null and template_id is null)
      or (content_type in ('DOCUMENT','IMAGE') and storage_path is not null and text_content is null and link_url is null and template_id is null)
      or (content_type = 'LINK' and link_url is not null and storage_path is null and text_content is null and template_id is null)
      or (content_type = 'WHATSAPP_TEMPLATE_REFERENCE' and template_id is not null and template_name is not null and storage_path is null and text_content is null and link_url is null))
);
create index if not exists content_library_items_customer_active_idx on public.content_library_items(customer_id, created_at desc) where archived_at is null;
alter table public.content_library_items enable row level security;
create policy "content library workspace members can read" on public.content_library_items for select to authenticated using (
  exists (select 1 from public.workspace_members wm where wm.customer_id = content_library_items.customer_id and wm.user_id = auth.uid())
  or exists (select 1 from public.customers c where c.id = content_library_items.customer_id and c.auth_user_id = auth.uid()));
create policy "content library managers can insert" on public.content_library_items for insert to authenticated with check (
  created_by = auth.uid() and (exists (select 1 from public.workspace_members wm where wm.customer_id = content_library_items.customer_id and wm.user_id = auth.uid() and wm.role in ('owner','admin')) or exists (select 1 from public.customers c where c.id = content_library_items.customer_id and c.auth_user_id = auth.uid())));
create policy "content library managers can update" on public.content_library_items for update to authenticated using (
  exists (select 1 from public.workspace_members wm where wm.customer_id = content_library_items.customer_id and wm.user_id = auth.uid() and wm.role in ('owner','admin')) or exists (select 1 from public.customers c where c.id = content_library_items.customer_id and c.auth_user_id = auth.uid())) with check (
  exists (select 1 from public.workspace_members wm where wm.customer_id = content_library_items.customer_id and wm.user_id = auth.uid() and wm.role in ('owner','admin')) or exists (select 1 from public.customers c where c.id = content_library_items.customer_id and c.auth_user_id = auth.uid()));
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('content-library','content-library',false,10485760,array['application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','image/jpeg','image/png','image/webp']) on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "content library objects workspace members can read" on storage.objects for select to authenticated using (bucket_id='content-library' and exists (select 1 from public.workspace_members wm where wm.customer_id::text=(storage.foldername(name))[1] and wm.user_id=auth.uid()));
create policy "content library objects managers can upload" on storage.objects for insert to authenticated with check (bucket_id='content-library' and exists (select 1 from public.workspace_members wm where wm.customer_id::text=(storage.foldername(name))[1] and wm.user_id=auth.uid() and wm.role in ('owner','admin')));
create policy "content library objects managers can update" on storage.objects for update to authenticated using (bucket_id='content-library' and exists (select 1 from public.workspace_members wm where wm.customer_id::text=(storage.foldername(name))[1] and wm.user_id=auth.uid() and wm.role in ('owner','admin'))) with check (bucket_id='content-library' and exists (select 1 from public.workspace_members wm where wm.customer_id::text=(storage.foldername(name))[1] and wm.user_id=auth.uid() and wm.role in ('owner','admin')));
create policy "content library objects managers can delete" on storage.objects for delete to authenticated using (bucket_id='content-library' and exists (select 1 from public.workspace_members wm where wm.customer_id::text=(storage.foldername(name))[1] and wm.user_id=auth.uid() and wm.role in ('owner','admin')));

