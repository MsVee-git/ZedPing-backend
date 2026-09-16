const supabase = require('./supabase')

async function recordConversationEvent({ customerId, conversationId, actorUserId = null, eventType, metadata = {} }) {
  const { error } = await supabase.from('conversation_events').insert({
    customer_id: customerId,
    conversation_id: conversationId,
    actor_user_id: actorUserId,
    event_type: String(eventType).slice(0, 80),
    metadata
  })
  if (error) throw error
}

module.exports = { recordConversationEvent }
