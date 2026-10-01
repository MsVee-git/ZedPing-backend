const META_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,255}$/

function parseInboundReplyContext(message) {
  const value = typeof message?.context?.id === 'string' ? message.context.id.trim() : ''
  return META_MESSAGE_ID.test(value) ? value : null
}

function messageReplyPreview(message) {
  const body = String(message?.message_body || '').trim().slice(0, 1200)
  if (body) return body
  const media = message?.outbound_media || message?.inbound_media || null
  if (!media) return 'Original message unavailable'
  if (media.type === 'image') return `[Customer replied to an image message${media.caption ? `: "${String(media.caption).slice(0, 300)}"` : ''}]`
  if (media.type === 'document') return `[Customer replied to document: ${String(media.filename || 'document').slice(0, 180)}]`
  if (media.type === 'location') return `[Customer replied to location: ${[media.name, media.address].filter(Boolean).join(', ') || 'shared location'}]`
  return 'Original message unavailable'
}

function aiReplyContext(message) {
  if (!message) return null
  return `Customer replied to:\n${messageReplyPreview(message)}`
}

function matchingReplyMessage(messages, scope) {
  return (messages || []).find(message =>
    message?.customer_id === scope.customerId &&
    message?.whatsapp_number_id === scope.whatsappNumberId &&
    (!message.conversation_id || message.conversation_id === scope.conversationId) &&
    (!message.contact_id || message.contact_id === scope.contactId)
  ) || null
}

module.exports = { parseInboundReplyContext, messageReplyPreview, aiReplyContext, matchingReplyMessage }
