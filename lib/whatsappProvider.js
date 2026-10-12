// Resolve provider from server-owned mapping, never from request parameters.
function createWhatsAppTextRouter({ loadMapping, metaSendText, resolveMetaToken, gupshup, allowGupshup = () => false }) {
  return async function sendText({ customerId, number, to, body, replyToMessageId = null }) {
    if (!customerId || !number?.id || number.customer_id !== customerId) throw new Error('WhatsApp connection ownership mismatch')
    const mapping = await loadMapping({ customerId, connectionId: number.id })
    if (mapping) {
      if (!allowGupshup(customerId) || mapping.link_state !== 'linked' || !mapping.app_id) throw new Error('Gupshup messaging is not enabled')
      const result = await gupshup.sendText(mapping.app_id, { to, body, replyToMessageId })
      return { messages: [{ id: result.messageId }], provider: 'gupshup', delivery_status: 'accepted' }
    }
    return metaSendText(number.phone_number_id, to, body, await resolveMetaToken(number, { customerId }), replyToMessageId)
  }
}
module.exports = { createWhatsAppTextRouter }
