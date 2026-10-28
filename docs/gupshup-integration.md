# WhatsApp onboarding and provider routing

## Current release

New clients connect from **Connect WhatsApp** inside ZedPing. They authorise their business and number through Meta Embedded Signup; they do not need a Gupshup account or partner-portal login. ZedPing creates and associates their provider app through the server API after validating Meta ownership.

Existing Meta-connected numbers retain their current provider. Enabling production onboarding does not migrate them. An existing live Meta connection still requires the explicit migration process rather than a duplicate signup.

## Configuration

Server-only credentials and configuration:

- `GUPSHUP_PARTNER_EMAIL`, `GUPSHUP_PARTNER_SECRET`; the configured Universal Token can be used instead of legacy partner/app token retrieval.
- `GUPSHUP_SOLUTION_ID`, `GUPSHUP_WALLET_ID`, `GUPSHUP_CALLBACK_URL`.
- `GUPSHUP_WEBHOOK_SECRET`: at least 32 characters, sent as a subscription header and checked on receipt.
- `GUPSHUP_ONBOARDING_ENABLED=true` enables partner signup.
- `GUPSHUP_PRODUCTION_ONBOARDING=true` permits production workspaces. Without it, `GUPSHUP_TEST_CUSTOMER_IDS` remains an optional limited rollout list.
- `GUPSHUP_ROUTING_ENABLED=true`, `GUPSHUP_WEBHOOK_ENABLED=true` and `GUPSHUP_WORKER_ENABLED=true` enable the corresponding routing, reception and processing paths.

Do not disable provider routing as a shortcut to returning migrated numbers to Meta. A Gupshup mapping fails closed when unavailable; it never silently falls back to Meta.

## Completion and recovery

1. An owner/admin prepares a signed, workspace/user-bound signup session.
2. The browser includes the approved Joint Solution ID in Meta's signup options and captures the selected phone ID and WABA ID. Meta callback events and the OAuth code can arrive in either order.
3. The backend exchanges the one-use code and keeps the resulting credential in the server-only vault. Phone/WABA ownership is verified independently of browser-provided IDs.
4. A scoped connection and provider mapping are created. App linking is atomically claimed and uses a deterministic app name. An uncertain creation result requires confirmation rather than another app creation.
5. Gupshup performs phone registration. This branch never calls Meta's direct registration endpoint.
6. The dashboard polls the authenticated activation-status endpoint. Only an explicit provisioned pipeline result, enabled routing and a confirmed subscription permit the number to become operational.
7. The subscription receives incoming messages plus SENT, DELIVERED, READ and FAILED receipts. An existing complete subscription is reused; only ZedPing's own tagged subscription is updated when necessary.
8. Workspace responses include the safe connection ID and activation state so the dashboard can display **Connected** immediately after finalisation.

The browser saves pending completion metadata in session storage scoped to the workspace/user. It does not persist the OAuth code. Reloading resumes confirmation of the existing setup; polling is bounded and a manual **Check connection** action remains available.

For direct Meta signup, recovery checks the exact phone's explicit registration status and restores the app subscription without registering it twice. Unknown external outcomes are not treated as permission to repeat a mutation.

## Messaging and accounting

Staff messages, attachments, template broadcasts and AI/automation replies use the shared server-side provider runtime. Inbound events are authenticated, durably recorded and scoped to the provider app/workspace before processing. Repeated event identities do not invoke automation twice. STOP commands remain effective, and human control takes precedence over automation.

Usage is enforced on the backend. The corresponding allowance period must be configured before sending. Broadcasts may partially send when allowance is exhausted, as requested; individual accepted and failed submissions are recorded. Provider acceptance is distinct from delivery, which is determined by receipts. An uncertain provider submission is not automatically resent or refunded.

Gupshup wallet funding is manual. ZedPing client plan activation, renewal and top-up accounting are separate from funding the shared provider wallet. Do not infer that a client has paid from the provider wallet balance.

## Support and validation

ZedPing support: **+260 778 621 168**. Website and dashboard support, renewal and top-up links use this number.

The automated suite exercises the real application handlers/runtime with external database, credential and messaging IO replaced by controlled fixtures. It covers workspace isolation, opt-outs, credential handling, receipt persistence, delayed activation and lost-response recovery. Browser acceptance covers both callback orders, pending partner activation and page-reload recovery. These checks do not represent a new customer's real Meta authorisation or a provider-side migration.

Provider references:
- https://partner-docs.gupshup.io/docs/tech-partner-hosted-embed-sign-up-flow
- https://partner-docs.gupshup.io/reference/setsubscription-api-v3
- https://partner-docs.gupshup.io/reference/get_partner-app-appid-subscription
- https://partner-docs.gupshup.io/reference/put_partner-app-appid-subscription-subscriptionid
