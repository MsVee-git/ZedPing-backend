-- Only one non-legacy live Zoe AI Agent may own a workspace WhatsApp number.
create unique index if not exists ai_agents_one_live_zoe_per_number_idx
  on public.ai_agents (customer_id, whatsapp_number_id)
  where lifecycle_status = 'active' and is_active = true and legacy_contained_at is null;
