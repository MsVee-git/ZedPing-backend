# AI lead follow-ups

This opt-in agent feature schedules future Live AI enquiries only. It does not backfill old leads. All offsets are from the last inbound customer message, not from previous follow-ups:

| Step | Behaviour |
| --- | --- |
| 1 hour | Generate a concise contextual follow-up through the existing precision review. Skip unsupported output. |
| 24 hours | Send the agent's selected approved static marketing template. |
| 72 hours | Send the final selected approved static marketing template. |
| 96 hours | Resolve the unanswered conversation, retaining its history. No closing message. |

## Release order

1. Apply `supabase/migrations/20261106195106_ai_lead_followup_jobs.sql` and verify its RLS, workspace-integrity trigger, constraints and indexes.
2. Deploy the backend, then dashboard. Keep `AI_LEAD_FOLLOWUPS_ENABLED` disabled until deployment checks pass.
3. Set `AI_LEAD_FOLLOWUPS_ENABLED=true` in the intended backend environment and verify worker startup.
4. On each intended Live agent, enable Lead follow-ups, select approved marketing templates for 24 and 72 hours, save the draft and explicitly Update Live. No existing agent is enabled automatically. Templates must have body/footer text only, without variables, headers or buttons.
5. Use consented test leads to exercise sends and verify the queue and inbox. The worker polls every 30 seconds; times are approximate, not exact-second guarantees.

## Runtime guarantees and limits

Jobs are persisted with one unique row per conversation, inbound anchor and step. Compare-and-set claims prevent concurrent replicas from dispatching the same row twice. Every send rechecks workspace, agent/version, conversation state, latest inbound timestamp, opt-out status and session status. Replies, takeover/handoff and changes of live version cancel old work. Pause cancels AI sessions, preventing old jobs from resuming later.

A customer reply cancels the old sequence; a subsequent supported AI answer may enroll that new unanswered enquiry. Explicit declines and simple conversation-ending acknowledgements do not enroll. One-hour generation can choose SKIP to cancel the sequence. Later templates are fixed approved messages, not AI-generated text. Outbound sends never reset the inbound anchor or 24-hour service window.

Expired missed stages are skipped, so downtime cannot produce a catch-up burst. Provider failures, or worker interruption after claiming a job, are never automatically replayed. Inspect actual delivery before any manual resend. This prioritises avoiding duplicates over guaranteed delivery. As with other external sends, there is a small race between the final eligibility read and provider submission; an inbound message arriving during that external call cannot recall a submitted message.

The closure is an internal resolved state, not deletion; a new inbound message follows existing conversation reopening behaviour. Marketing templates and AI generation can incur usage charges. Template approval/availability, messaging allowance and recipient eligibility can block a stage. The sequence must only be enabled for appropriately consented leads.

## Verification

53 backend tests cover the new schedule, template eligibility, cancellation, precision failures, concurrent workers, missed stages, uncertain sends and closure, plus existing AI runtime cases. 31 dashboard tests cover saved settings/template controls and existing agent lifecycle behaviour; production build passes. SQL was parsed, but the migration has not been applied and no real provider send has been performed. Complete deployment checks before enabling the worker.
