const supabase = require('./supabase')
const { recordAiExecutionEvent } = require('./aiExecutionEvents')

async function closeActiveAiSessionsForConversation({ customerId, whatsappNumberId, conversationId, contactPhone, reason = 'human_takeover' }) {
  let query = supabase.from('ai_agent_sessions').select('id,agent_id,agent_version,conversation_id,contact_phone')
    .eq('customer_id', customerId).eq('whatsapp_number_id', whatsappNumberId).eq('status', 'active')
  if (conversationId && contactPhone) query = query.or(`conversation_id.eq.${conversationId},contact_phone.eq.${contactPhone}`)
  else if (conversationId) query = query.eq('conversation_id', conversationId)
  else if (contactPhone) query = query.eq('contact_phone', contactPhone)
  else return []

  const { data: sessions, error } = await query
  if (error) throw error
  const now = new Date().toISOString()
  for (const session of sessions || []) {
    const { data, error: updateError } = await supabase.from('ai_agent_sessions').update({
      status: 'handed_off', ended_at: now, completion_reason: reason, last_activity_at: now
    }).eq('id', session.id).eq('customer_id', customerId).eq('whatsapp_number_id', whatsappNumberId).eq('status', 'active').select().maybeSingle()
    if (updateError) throw updateError
    if (data) await recordAiExecutionEvent(supabase, {
      customerId, whatsappNumberId, agentId: data.agent_id, sessionId: data.id,
      agentVersion: data.agent_version, model: 'gpt-4o-mini', outcome: 'handed_off'
    }).catch(() => {})
  }
  return sessions || []
}

module.exports = { closeActiveAiSessionsForConversation }
