const { parseInboundMedia } = require('./inboundMedia')
function normalizeGupshupIncoming(payload, mapping, number) {
  if (payload?.gs_app_id !== mapping?.app_id || !mapping?.app_id ||
      mapping.customer_id !== number?.customer_id || mapping.whatsapp_number_id !== number?.id) {
    throw new Error('Gupshup callback mapping mismatch')
  }
  if (payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) throw new Error('Invalid Gupshup callback')
  const events = []
  for (const entry of payload.entry) {
    if (entry.id && entry.id !== number.whatsapp_business_account_id) throw new Error('Gupshup WABA mismatch')
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue
      const value = change.value || {}
      if (value.metadata?.phone_number_id && value.metadata.phone_number_id !== number.phone_number_id) throw new Error('Gupshup phone mismatch')
      for (const message of value.messages || []) {
        if (typeof message.id !== 'string' || !message.id || !/^[1-9][0-9]{6,14}$/.test(message.from || '')) throw new Error('Invalid Gupshup message')
        if (!['text','image','document','location'].includes(message.type)) throw new Error('Unsupported Gupshup message type')
        if (message.type === 'text' && (typeof message.text?.body !== 'string' || message.text.body.length > 4096)) throw new Error('Invalid Gupshup text')
        const parsed = parseInboundMedia(message)
        if (message.type !== 'text' && !parsed.media) throw new Error('Invalid Gupshup media metadata')
        events.push({ event_key: `message:${message.id}`, event_type: 'message', payload: {
          message_id: message.id, from: message.from, body: parsed.body, media: parsed.media,
          reply_to_message_id: message.context?.id || null, timestamp: message.timestamp || null
        } })
      }
      for (const status of value.statuses || []) {
        if (status.type === 'set-callback') continue
        if (!['sent','delivered','read','failed','enqueued'].includes(status.status) || typeof status.id !== 'string' || !status.id) throw new Error('Invalid Gupshup delivery event')
        events.push({ event_key: `status:${status.id}:${status.status}`, event_type: 'status', payload: {
          message_id: status.id, gupshup_message_id: status.gs_id || null,
          status: status.status, timestamp: status.timestamp || null
        } })
      }
    }
  }
  if (events.length > 100) throw new Error('Gupshup callback batch too large')
  return events
}

async function persistGupshupEvents(db, mapping, events) {
  if (!events.length) return
  const rows = events.map(event => ({ ...event, customer_id: mapping.customer_id,
    whatsapp_number_id: mapping.whatsapp_number_id, app_id: mapping.app_id }))
  const { error } = await db.from('gupshup_webhook_events').upsert(rows, {
    onConflict: 'app_id,event_key', ignoreDuplicates: true
  })
  if (error) throw new Error('Unable to persist Gupshup callback')
}

module.exports = { normalizeGupshupIncoming, persistGupshupEvents }
