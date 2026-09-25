# Marketing opt-out schema compatibility

Production project `zzhqhgeyxbdqdkacrviq` was checked read-only on 2026-09-25.
Migration history records `20260925074210 marketing_opt_out_suppression`.

The `public.contacts` columns are:

- `marketing_opted_out boolean NOT NULL DEFAULT false`
- `marketing_opted_out_at timestamp with time zone NULL`
- `marketing_opt_out_source text NULL`

The index `contacts_customer_marketing_eligibility_idx` covers
`(customer_id, marketing_opted_out)`.

These match the schema expected by the recovered implementation. The preserved
bundle used repository filename `20260925090000_marketing_opt_out_suppression.sql`,
but production applied it under the version above. This integration deliberately
does not add a second pending migration or execute any migration. On a fresh
database, provision these fields through its normal migration process before
running this code; do not rerun the already-applied migration in production.
