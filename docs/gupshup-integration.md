# Gupshup integration foundation

The server-only `lib/gupshupPartner.js` adapter is not connected to production routes yet. It supports client-secret login, an in-memory partner token cache with concurrent login deduplication, app-token retrieval and read-only provisioning status lookup. Errors deliberately exclude provider bodies and credentials. It does not automatically retry mutations or switch existing client connections.

## Verified flow and remaining implementation

1. Add the approved Joint Solution ID to Embedded Signup `extras.setup.solutionID` for explicitly selected Gupshup onboarding sessions.
2. Preserve workspace ownership checks and signed sessions. Capture verified WABA, phone ID and actual international phone number; the linking API requires the phone number, not merely its Meta ID.
3. Link the app using POST `/partner/tpp/app` with partner Bearer authorization, unique alphanumeric name, WABA, phone and wallet ID. Persist an attempt before mutation and reconcile uncertain outcomes instead of blindly repeating app creation.
4. Gupshup handles registration and 2FA. Do not execute the existing direct-Meta `registerPhone` path for Gupshup sessions.
5. Retrieve app token and pipeline state. HTTP 200 can still carry `creationStage: ERROR`; never mark that connected.
6. Set callback during linking, then subscribe only after the app is live. Validate webhook authenticity and workspace mapping before enabling events.
7. Implement message/template/media adapters, delivery reconciliation and usage reservations before enabling a client. Preserve direct-Meta routing for existing clients until individually migrated.

## Required configuration and unresolved details

Partner email and client secret must be supplied through server secret configuration, never the browser. Solution ID and prepaid wallet ID are also required. No credentials have been requested or tested by this local change.

The login page narrative and curl use `secret`; its OpenAPI schema says `password`. This adapter follows the narrative client-secret example; confirm with a controlled authentication check before activation. Partner token lifetime is documented as 24 hours. App-token lifetime is not assumed.

Wallet balance/funding APIs, client-level accounting, migration requirements and webhook signature verification still need review. No wallet operations or customer migrations are implemented in this foundation.

Sources reviewed October 9, 2026:
- https://partner-docs.gupshup.io/reference/post_partner-account-login
- https://partner-docs.gupshup.io/docs/tech-partner-hosted-embed-sign-up-flow

## Implemented local routing and storage (not released)

The new migration adds a server-only mapping table, a composite connection/workspace foreign key, globally unique app IDs/names and a compare-and-set linking state. Browser roles have no access. No credentials are stored in it. Prepared signup sessions record their provider; the completion request cannot select or substitute it.

`GUPSHUP_ONBOARDING_ENABLED=true` and `GUPSHUP_TEST_CUSTOMER_IDS` are both required to select Gupshup. Also required: `GUPSHUP_PARTNER_EMAIL`, `GUPSHUP_PARTNER_SECRET`, `GUPSHUP_SOLUTION_ID`, `GUPSHUP_WALLET_ID`, `GUPSHUP_CALLBACK_URL`. Keep the flag off until the dashboard consumes `solution_id`, verified webhook handling is ready and the callback exists. The migration must precede deployment because the routes select its new columns/table even with onboarding disabled.

Completion validates Meta ownership, creates a pending connection, atomically claims its mapping, links it and returns HTTP 202. It does not mark connected or complete the session. Gupshup-mapped connections cannot use the direct-Meta retry endpoint. Existing unmapped records are not migrated by this path. A linking claim is never automatically reclaimed after a timeout/restart; reconcile the provider app first.

Remaining: dashboard Joint Solution configuration, live-event verification, subscription, messaging adapters, operational acceptance and explicit guided migration. No production flag or schema has changed.

Validation: 11 Gupshup unit tests and 28 existing Embedded Signup tests passed. Migration executed against a temporary PGlite PostgreSQL engine: cross-workspace ownership rejected, concurrent claims yielded one winner, linked state required an app ID, anon/authenticated access denied, existing connection retained. Production Supabase validation and advisors remain outstanding.

## Subscription and text adapter

Added subscription configuration using documented `meta` custom header `X-Gupshup-Webhook-Secret`, version 3 and ALL modes. Added constant-time shared-secret authentication and app-to-workspace validation helpers. These are not a webhook endpoint or durable event ingestion yet; the initial app-link callback's authentication still needs separate verification. A subscription must not be automatically recreated on retries without checking its existing configuration.

Added the v3 text-message request with optional quoted-reply context. Results mean accepted, not delivered. Caller must enforce service-window eligibility, consent, usage reservation and uncertain-send reconciliation before using it in production. No live sends are wired.

Sources: https://partner-docs.gupshup.io/reference/setsubscription-api-v3 and https://partner-docs.gupshup.io/reference/post_partner-app-appid-v3-text-message. Fifteen Gupshup tests pass. MM Lite templates, durable incoming event handling, media and provider routing remain outstanding.

## Durable callback intake foundation

Added an unmounted webhook router for subscription v3 events (`gs_app_id`, Meta-shaped entries). It authenticates the custom secret header, validates server app/workspace/WABA/phone mapping, and inserts normalized text and delivery events before returning empty HTTP 200. Storage failures return 503 for provider retry. Event keys and ignore-duplicate inserts preserve existing queue state. Unsupported media is refused rather than silently lost; full media acceptance remains a release gate.

A new server-only queue migration protects event ownership with a composite mapping reference and denies browser-role access. The earlier mapping migration was validated in temporary PostgreSQL (PGlite). The new queue migration has not been execution-tested: that temporary database harness is no longer present. Eighteen Gupshup tests pass. No worker is connected to Team Inbox yet: existing automation replies are Meta-specific, so provider-aware replies must be built before enabling this endpoint. The route is not mounted, and no production migration was applied.

Payload source: https://partner-docs.gupshup.io/docs/passthrough-v3-incoming-events ; acknowledgment/retry source: https://partner-docs.gupshup.io/docs/webhook-key-points.

## Provider routing and worker contracts

Added server-mapping-based text router: mapped Gupshup connections never resolve Meta tokens or fall back to Meta on disabled/failed Gupshup sends. Added worker dispatch contract requiring inbox persistence plus queue completion in one database transaction, and separate delivery reconciliation. These are dependency-injected foundations, not implemented database worker adapters or live route wiring. Automation outbound effects require an outbox before enabling retries safely.

Recreated temporary PGlite harness and successfully executed both new migrations. Queue duplicate keys, app/workspace foreign key and anon/authenticated denial passed. Twenty-three Gupshup/provider tests pass. Production remains unchanged.

## Transactional text-to-inbox pilot

Added `process_next_gupshup_text_event` SECURITY INVOKER RPC, callable only by service_role. It selects and locks one pending text event, validates mapping, serializes contact creation, persists contact/conversation/message plus scoped quote context, and completes the queue row in one transaction. Failures roll back the entire operation. A bounded JS runner invokes it explicitly; no schedule or endpoint is enabled.

New conversations and reopened conversations enter needs_attention in this inbox-only pilot. Existing open/human state is preserved. AI/automation execution, marketing opt-out processing, delivery reconciliation and full media handling remain release gates; this pilot must not be enabled as the full messaging flow.

Twenty-five Gupshup/provider unit tests pass. SQL executed against a temporary representative PostgreSQL schema: created inbox records, completed queue row and a repeated run returned idle. Real production schema compatibility, rollback fault injection and concurrency acceptance remain outstanding.

## Further implementation and verification

Added transactional STOP/STOP ALL/UNSUBSCRIBE/CANCEL/END/QUIT suppression, image/document/location metadata normalization and persistence, and a delivery RPC with scoped message matching and protection against downgrading delivered/read states. Incoming media bytes are not downloaded yet. The published download guide states five requests/hour, which needs clarification before selecting that mechanism for normal inbox traffic: https://partner-docs.gupshup.io/reference/downloadmedia.

Read-only production information_schema inspection confirmed the contacts/conversations/messages/whatsapp_numbers column names used by these migrations. No production DDL or customer records were changed. Local SQL with STOP passed and set contact suppression. Twenty-six Gupshup/provider tests pass.

This is NOT a finished integration. Remaining code: outbound media and MM Lite templates, live provider routing through staff/automation/AI execution paths, durable outbound reservations/outbox and usage enforcement, background scheduling, subscription lifecycle reconciliation and operational activation. Remaining acceptance: delivery RPC fault/concurrency tests, actual production constraints/triggers/RLS replay, media download clarification, secure credentials and an active test phone. Keep all flags off and do not migrate clients until these are complete.

Added MM Lite marketing-template and v3 utility/authentication-template request adapters, plus image/document sending by media ID. Marketing routing is verified by mocked request tests. Twenty-seven Gupshup/provider tests pass. These adapters are not live-wired and full template components/namespace compatibility still require live acceptance. Media upload/download, usage reservation/outbox, automation activation and operational proof remain incomplete. Do not enable the integration on the strength of unit tests.

## Media upload, live text route wiring and usage reservation

Added multipart image/PDF upload (bounded 16MB, no arbitrary URL fetch). Wired staff replies, generic text sends and the shared AI/automation outbound text callback through `whatsappRuntime`. Existing route behavior is retained with GUPSHUP_ROUTING_ENABLED off. When enabled, server mappings select Gupshup; credentials/configuration failures never fall back to Meta. This flag must not be turned off for migrated accounts without an explicit rollback plan.

Added service/template/AI usage-period and reservation tables plus an atomic reservation RPC. Text sends require an explicitly configured service allowance before provider submission. Ambiguous or failed submissions keep their reservation; do not automatically resend or refund. No customer quotas or subscriber terms were populated. Top-up payments and monthly allowance assignment are not implemented yet.

Thirty-five focused tests passed, including existing signup recovery; syntax/diff checks passed. Temporary PostgreSQL executed all four migrations, STOP/inbox flow, and simultaneous reservations against allowance one produced exactly one success. Real provider acceptance remains untested. Media upload is still an adapter, not wired to the staff attachment route. Broadcast templates, inbound automation execution/outbox, background schedule and operational activation remain unfinished. Do not release these flags.

## Attachment/broadcast wiring and incoming automation worker

Staff attachment route now uploads/sends through the selected provider. Reviewed template broadcasts route each recipient through category-aware Gupshup sending and reserve template allowance before submission. Existing recipient review and marketing suppression stay in place. This is per-recipient enforcement; a broadcast larger than remaining allowance can partially send rather than being rejected as a whole.

Extracted the existing inbound AI/flow/automation engine for invocation after durable inbox persistence. New worker reloads message/contact/conversation/number within the workspace and atomically claims each automation event. Completed or uncertain claims are not re-run. Execution failures enter confirmation_required; abandoned processing claims require manual reconciliation. STOP messages remain suppressed. Inbox-created needs_attention conversations do not automatically run AI: team control rules still apply.

Added explicit pipeline runner for inbox, delivery and automation. No startup scheduler or webhook mount is enabled. Requires both GUPSHUP_WORKER_ENABLED and GUPSHUP_ROUTING_ENABLED; onboarding flags and credentials also remain prerequisites. Thirty-nine focused tests passed, all five migrations executed locally, STOP and concurrent last-message reservations verified. End-to-end provider testing, quote context enrichment, AI-specific usage budgets, inbound media downloads, scheduled broadcast routing and full release acceptance remain outstanding. Production unchanged.
