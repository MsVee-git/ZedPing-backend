const supabase = require('./supabase')
const { recordAiExecutionEvent } = require('./aiExecutionEvents')

async function closeActiveAiSessionsForConversation({ customerId, whatsappNumberId, conversationId, contactPhone, reason = 'human_takeover' }) {
  if (!conversationId && !contactPhone) return []

  const { data: candidates, error } = await supabase
    .from('ai_agent_sessions')
    .select('id,agent_id,agent_version,conversation_id,contact_phone')
    .eq('customer_id', customerId)
    .eq('whatsapp_number_id', whatsappNumberId)
    .eq('status', 'active')
  if (error) throw error

  // Filter immutable, server-fetched session attributes rather than interpolating
  // customer data into a PostgREST `.or()` expression.
  const sessions = (candidates || []).filter((session) =>
    (conversationId && session.conversation_id === conversationId) ||
    (contactPhone && session.contact_phone === contactPhone)
  )

  const now = new Date().toISOString()
  for (const session of sessions) {
    const { data, error: updateError } = await supabase.from('ai_agent_sessions').update({
      status: 'handed_off', ended_at: now, completion_reason: reason, last_activity_at: now
    }).eq('id', session.id).eq('customer_id', customerId).eq('whatsapp_number_id', whatsappNumberId).eq('status', 'active').select().maybeSingle()
    if (updateError) throw updateError
    if (data) await recordAiExecutionEvent(supabase, {
      customerId, whatsappNumberId, agentId: data.agent_id, sessionId: data.id,
      agentVersion: data.agent_version, model: 'gpt-4o-mini', outcome: 'handed_off'
    }).catch(() => {})
  }
  return sessions
}

module.exports = { closeActiveAiSessionsForConversation }
