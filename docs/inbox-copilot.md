# Inbox copilot pilot

Workspace-authenticated endpoints: `GET /inbox-copilot/access` and `POST /inbox-copilot`.
The POST body accepts `mode: summary|classify|draft`; the latter two require a conversation UUID.
Customer/workspace IDs in the body are ignored. Permissions match the existing workspace-wide inbox reads.

Business and Pro subscriptions in active/trial status are eligible. Starter is denied server-side.
Temporary pilot limits are 100 requests per calendar UTC month for Business and 300 for Pro.
Override with positive integer `COPILOT_BUSINESS_MONTHLY_REQUESTS` / `COPILOT_PRO_MONTHLY_REQUESTS` (maximum 10,000).
These are pilot request limits, not final commercial allowances and not WhatsApp message allowances.
All reserved attempts count, including failures with uncertain provider usage. Three requests per workspace per minute.
Reservations are serialized per workspace in PostgreSQL; the API fails closed if accounting is unavailable.

The summary samples the 20 most recently active unresolved conversations, not every conversation.
Each selected conversation contributes up to 12 recent text messages, within a combined 16,000-character budget.
Drafts use up to five nonarchived knowledge sources through the existing approved-image revision resolver.
Knowledge input is capped at 1,200 characters per source. The AI has no tools and no mutation capability.
The existing server-controlled model/API credential are reused. Provider retries are disabled, timeout 45 seconds, output cap 2,200 tokens.

No messages are sent and no classifications are saved by these endpoints. The client can insert a draft only into an empty, authorised text reply composer. The normal Send action remains mandatory.
Messages, classifications and replies are not persisted in the new usage table, which records IDs, state, timestamps and token counts only.
The UI labels results as suggestions and shows scope; staff should verify facts and use the conversation links.

Apply `20261015201550_inbox_copilot_usage.sql` before deploying the backend. Deploy the dashboard after backend health checks.
Rollback: revert the route mount and dashboard component; leave the additive server-only usage table in place.
