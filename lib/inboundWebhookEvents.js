function inboundEventPayload(ctx) {
  const metaMessageId = typeof ctx?.metaId === 'string' ? ctx.metaId.trim() : ''
  if (!metaMessageId) return null
  return {
    customer_id: ctx.customerId,
    whatsapp_number_id: ctx.number.id,
    meta_message_id: metaMessageId
  }
}

function isDuplicateInboundEventError(error) {
  return error?.code === '23505'
}

module.exports = { inboundEventPayload, isDuplicateInboundEventError }
