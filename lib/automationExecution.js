const supabase = require('./supabase')

const EVENT_TYPES = new Set(['triggered', 'skipped', 'response_sent', 'handoff_initiated', 'error'])
const OUTCOMES = new Set(['success', 'skipped', 'error'])

function safeMetadata(value = {}) {
  const allowed = ['reason', 'action_kind', 'content_type', 'rule_kind']
  const result = {}
  for (const key of allowed) if (typeof value[key] === 'string' && value[key].length <= 80) result[key] = value[key]
  return result
}

async function recordAutomationEvent(ctx, eventType, outcome, metadata = {}, automationId = null) {
  if (!EVENT_TYPES.has(eventType) || !OUTCOMES.has(outcome)) throw new Error('Automation execution event is invalid')
  const { error } = await supabase.from('automation_execution_events').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number?.id || null, contact_id: ctx.contact?.id || null,
    conversation_id: ctx.conversation?.id || null, automation_id: automationId,
    event_type: eventType, outcome, metadata: safeMetadata(metadata)
  })
  if (error) throw error
}

async function claimWelcome(ctx, automationId) {
  const { error } = await supabase.from('automation_welcome_deliveries').insert({
    customer_id: ctx.customerId, whatsapp_number_id: ctx.number.id, contact_id: ctx.contact.id,
    first_automation_id: automationId, status: 'pending'
  })
  if (!error) return true
  if (error.code === '23505') return false
  throw error
}

async function completeWelcome(ctx, outboundMessageId) {
  const { error } = await supabase.from('automation_welcome_deliveries').update({
    status: 'sent', delivered_at: new Date().toISOString(), outbound_message_id: outboundMessageId || null
  }).eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('contact_id', ctx.contact.id).eq('status', 'pending')
  if (error) throw error
}

async function releaseWelcome(ctx) {
  await supabase.from('automation_welcome_deliveries').delete()
    .eq('customer_id', ctx.customerId).eq('whatsapp_number_id', ctx.number.id).eq('contact_id', ctx.contact.id).eq('status', 'pending')
}

module.exports = { recordAutomationEvent, claimWelcome, completeWelcome, releaseWelcome, safeMetadata }

