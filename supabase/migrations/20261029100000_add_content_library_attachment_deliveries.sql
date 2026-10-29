create table if not exists public.content_library_attachment_deliveries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  whatsapp_number_id uuid not null references public.whatsapp_numbers(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  inbound_meta_message_id text not null,
  content_library_item_id uuid not null references public.content_library_items(id) on delete restrict,
  source text not null check (source in ('automation','ai')),
  status text not null check (status in ('pending','accepted','confirmation_required')),
  provider_media_id text,
  outbound_message_id uuid references public.messages(id) on delete set null,
  error_category text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (customer_id, inbound_meta_message_id, content_library_item_id, source)
);

create index if not exists content_library_attachment_deliveries_conversation_idx
  on public.content_library_attachment_deliveries(customer_id, conversation_id, created_at desc);

alter table public.content_library_attachment_deliveries enable row level security;

create policy content_library_attachment_deliveries_read_workspace
  on public.content_library_attachment_deliveries for select to authenticated
  using (public.is_workspace_member(customer_id));

revoke all on public.content_library_attachment_deliveries from public, anon, authenticated;
