-- Business/support email is not a permanent workspace identity. It may be
-- shared or reused after an account is recreated.
alter table public.customers drop constraint if exists customers_email_key;

create index if not exists customers_email_lookup_idx
  on public.customers (lower(email));

-- The signup path may create only one initial workspace for one Auth identity.
-- Additional workspace access is modelled by workspace_members.
create unique index if not exists customers_auth_user_id_unique
  on public.customers (auth_user_id)
  where auth_user_id is not null;
